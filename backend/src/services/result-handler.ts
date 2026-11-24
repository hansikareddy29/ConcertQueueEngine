import crypto from 'crypto';
import { getDb, IDatabase } from '../db/connection.js';
import { PaymentResult, simulator } from './payment-simulator.js';

export class ResultHandler {
  constructor(
    private db?: IDatabase,
    private onCapacityFreed?: (eventId: string) => void
  ) {}

  private async getDatabase(): Promise<IDatabase> {
    if (!this.db) {
      this.db = await getDb();
    }
    return this.db;
  }

  setOnCapacityFreed(callback: (eventId: string) => void) {
    this.onCapacityFreed = callback;
  }

  /**
   * Handles payment verification result in one atomic transaction per Section 10 & 11.
   * Lock order: event_control -> payment_gateways -> assignments -> reservations/seats
   */
  async handlePaymentResult(result: PaymentResult): Promise<{ success: boolean; eventId?: string }> {
    const db = await this.getDatabase();
    const { assignmentId, paymentId, status, providerReference, providerEventId, durationMs, reason } = result;

    return await db.withTransaction(async (client) => {
      // 1. Check idempotency of provider event
      const existingReceipt = await client.query(
        `SELECT provider_event_id FROM callback_receipts WHERE provider_event_id = $1`,
        [providerEventId]
      );
      if (existingReceipt.rows.length > 0) {
        console.log(`[ResultHandler] Duplicate callback ${providerEventId} ignored.`);
        return { success: true };
      }

      // Record receipt
      await client.query(
        `INSERT INTO callback_receipts (provider_event_id, payment_id, received_at, processing_status)
         VALUES ($1, $2, NOW(), 'PROCESSING')
         ON CONFLICT (provider_event_id) DO NOTHING`,
        [providerEventId, paymentId]
      );

      // Fetch assignment info to determine event_id and gateway_id
      const assignInfo = await client.query(
        `SELECT a.assignment_id, a.gateway_id, a.gateway_generation, a.reservation_id, a.state, a.entry_id,
                r.event_id, r.seat_id, r.user_id, r.status as reservation_status
         FROM assignments a
         JOIN reservations r ON a.reservation_id = r.reservation_id
         WHERE a.assignment_id = $1`,
        [assignmentId]
      );

      if (assignInfo.rows.length === 0) {
        console.warn(`[ResultHandler] Assignment ${assignmentId} not found.`);
        return { success: false };
      }

      const assign = assignInfo.rows[0];
      const eventId = assign.event_id;
      const gatewayId = assign.gateway_id;
      const seatId = assign.seat_id;
      const userId = assign.user_id;
      const reservationId = assign.reservation_id;
      const entryId = assign.entry_id;

      // 2. Strict Lock Order Step 1: event_control lock
      await client.query(
        `SELECT event_id FROM event_control WHERE event_id = $1 FOR UPDATE`,
        [eventId]
      );

      // 3. Strict Lock Order Step 2: Lock gateway row
      const gwRes = await client.query(
        `SELECT gateway_id, status, generation, current_assignment_id 
         FROM payment_gateways 
         WHERE gateway_id = $1 AND event_id = $2 
         FOR UPDATE`,
        [gatewayId, eventId]
      );

      // 4. Strict Lock Order Step 3: Lock assignment & queue entry
      const aLock = await client.query(
        `SELECT assignment_id, state FROM assignments WHERE assignment_id = $1 FOR UPDATE`,
        [assignmentId]
      );

      if (aLock.rows.length === 0 || (aLock.rows[0].state !== 'ACTIVE' && aLock.rows[0].state !== 'RECONCILING')) {
        console.warn(`[ResultHandler] Assignment ${assignmentId} is not in ACTIVE/RECONCILING state (${aLock.rows[0]?.state}). Skipping.`);
        return { success: false, eventId };
      }

      // 5. Strict Lock Order Step 4: Lock reservation and seat
      const resLock = await client.query(
        `SELECT reservation_id, status FROM reservations WHERE reservation_id = $1 FOR UPDATE`,
        [reservationId]
      );
      const seatLock = await client.query(
        `SELECT seat_id, status, current_reservation_id, version FROM seats WHERE seat_id = $1 FOR UPDATE`,
        [seatId]
      );

      const isSuccessful = status === 'SUCCESS';

      if (isSuccessful) {
        // Confirmation Flow
        // Mark payment SUCCESS
        await client.query(
          `UPDATE payments 
           SET status = 'SUCCESS', provider_reference = $1, sampled_duration = $2, 
               sampled_outcome = 'SUCCESS', completed_at = NOW() 
           WHERE payment_id = $3`,
          [providerReference, durationMs, paymentId]
        );

        // Mark reservation CONFIRMED
        await client.query(
          `UPDATE reservations SET status = 'CONFIRMED' WHERE reservation_id = $1`,
          [reservationId]
        );

        // Mark seat SOLD (verified reservation owner)
        await client.query(
          `UPDATE seats SET status = 'SOLD', version = version + 1 WHERE seat_id = $1 AND current_reservation_id = $2`,
          [seatId, reservationId]
        );

        // Create confirmed booking
        const bookingId = `book_${crypto.randomUUID()}`;
        await client.query(
          `INSERT INTO bookings (booking_id, reservation_id, seat_id, user_id, payment_id, confirmed_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [bookingId, reservationId, seatId, userId, paymentId]
        );

        // Mark assignment COMPLETED
        await client.query(
          `UPDATE assignments SET state = 'COMPLETED', completed_at = NOW() WHERE assignment_id = $1`,
          [assignmentId]
        );

        // Mark queue entry CONFIRMED
        await client.query(
          `UPDATE queue_entries SET status = 'CONFIRMED', completed_at = NOW() WHERE entry_id = $1`,
          [entryId]
        );
      } else {
        // Failure / Cancellation Flow
        // Mark payment FAILED
        await client.query(
          `UPDATE payments 
           SET status = 'FAILED', provider_reference = $1, sampled_duration = $2, 
               sampled_outcome = $3, completed_at = NOW() 
           WHERE payment_id = $4`,
          [providerReference, durationMs, reason || 'FAILED', paymentId]
        );

        // Mark reservation FAILED
        await client.query(
          `UPDATE reservations SET status = 'FAILED' WHERE reservation_id = $1`,
          [reservationId]
        );

        // Release seat back to AVAILABLE only if this reservation still owns it
        await client.query(
          `UPDATE seats 
           SET status = 'AVAILABLE', current_reservation_id = NULL, version = version + 1 
           WHERE seat_id = $1 AND current_reservation_id = $2`,
          [seatId, reservationId]
        );

        // Mark assignment FAILED
        await client.query(
          `UPDATE assignments SET state = 'FAILED', completed_at = NOW() WHERE assignment_id = $1`,
          [assignmentId]
        );

        // Mark queue entry FAILED
        await client.query(
          `UPDATE queue_entries SET status = 'FAILED', completed_at = NOW() WHERE entry_id = $1`,
          [entryId]
        );
      }

      // Free the gateway unconditionally upon terminal completion if generation matches
      await client.query(
        `UPDATE payment_gateways 
         SET status = 'FREE', current_assignment_id = NULL, updated_at = NOW() 
         WHERE gateway_id = $1 AND event_id = $2 AND current_assignment_id = $3`,
        [gatewayId, eventId, assignmentId]
      );

      // Update callback receipt
      await client.query(
        `UPDATE callback_receipts SET processing_status = 'PROCESSED' WHERE provider_event_id = $1`,
        [providerEventId]
      );

      return { success: true, eventId };
    }).then((res) => {
      // After commit, notify dispatcher to refill freed gateway capacity
      if (res.eventId && this.onCapacityFreed) {
        this.onCapacityFreed(res.eventId);
      }
      return res;
    });
  }
}

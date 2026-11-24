import { wsManager } from './ws.manager.js';
import crypto from 'crypto';
import { getDb, IDatabase } from '../db/connection.js';
import { CONFIG } from '../config.js';
import { simulator, PaymentAttemptRequest } from './payment-simulator.js';

export interface DispatchOutcome {
  assigned: boolean;
  assignmentId?: string;
  gatewayId?: number;
  userId?: string;
  seatLabel?: string;
  queueSequence?: number;
  isSoldOut?: boolean;
}

export class DispatcherService {
  private isDispatching = false;
  private pendingTriggers = false;

  constructor(
    private db?: IDatabase,
    private paymentSimulator = simulator
  ) {}

  private async getDatabase(): Promise<IDatabase> {
    if (!this.db) {
      this.db = await getDb();
    }
    return this.db;
  }

  /**
   * Signals that new capacity or a new queue entry arrived.
   * Debounces execution so consecutive triggers batch effectively without racing.
   */
  triggerDispatch(eventId: string = CONFIG.DEFAULT_EVENT_ID): void {
    if (this.isDispatching) {
      this.pendingTriggers = true;
      return;
    }

    this.runDispatchLoop(eventId).catch((err) => {
      console.error('[Dispatcher Error] Unexpected error in runDispatchLoop:', err);
    });
  }

  private async runDispatchLoop(eventId: string): Promise<void> {
    this.isDispatching = true;
    try {
      let keepRunning = true;
      while (keepRunning) {
        this.pendingTriggers = false;
        // Attempt single atomic assignment
        const outcome = await this.dispatchNext(eventId);
        if (!outcome.assigned) {
          // If no assignment could be made (no free gateway, no waiting user, or sold out), stop
          keepRunning = this.pendingTriggers;
        } else {
          // One user assigned; immediately check if more free gateways exist
          keepRunning = true;
        }
      }
    } finally {
      this.isDispatching = false;
    }
  }

  /**
   * Performs ONE atomic assignment per Section 7, 10 of HLD:
   * 1. Lock event_control (ensures dispatch not paused and serializes dispatcher steps)
   * 2. Find and lock next FREE payment_gateway
   * 3. Find and lock oldest FIFO queue_entry with status = 'WAITING'
   * 4. Find and lock next AVAILABLE seat
   * 5. Atomically transition states:
   *    - reservation -> PENDING
   *    - seat -> HELD
   *    - gateway -> BUSY, generation++
   *    - queue_entry -> PROCESSING
   *    - payment -> PENDING
   * 6. Commit transaction (row locks released!).
   * 7. Trigger Payment Simulator outside transaction.
   */
  async dispatchNext(eventId: string): Promise<DispatchOutcome> {
    const db = await this.getDatabase();
    let paymentToStart: PaymentAttemptRequest | null = null;
    let outcome: DispatchOutcome = { assigned: false };

    outcome = await db.withTransaction(async (client) => {
      // 1. Lock event_control
      const ctrlRes = await client.query(
        `SELECT event_id, dispatch_paused FROM event_control WHERE event_id = $1 FOR UPDATE`,
        [eventId]
      );
      if (ctrlRes.rows.length === 0 || ctrlRes.rows[0].dispatch_paused) {
        return { assigned: false };
      }

      // 2. Lock next FREE gateway
      const gwRes = await client.query(
        `SELECT gateway_id, generation 
         FROM payment_gateways 
         WHERE event_id = $1 AND status = 'FREE' 
         ORDER BY gateway_id ASC 
         LIMIT 1 
         FOR UPDATE`,
        [eventId]
      );
      if (gwRes.rows.length === 0) {
        return { assigned: false }; // No free gateway
      }
      const gateway = gwRes.rows[0];

      // 3. Lock oldest FIFO WAITING queue entry
      const qRes = await client.query(
        `SELECT entry_id, user_id, queue_sequence, selected_seats 
         FROM queue_entries 
         WHERE event_id = $1 AND status = 'WAITING' 
         ORDER BY queue_sequence ASC 
         LIMIT 1 
         FOR UPDATE`,
        [eventId]
      );
      if (qRes.rows.length === 0) {
        return { assigned: false }; // Queue is empty
      }
      const queueEntry = qRes.rows[0];

      // 4. Find next AVAILABLE seat (preferring user's selected seats if available)
      let seatRes: any = null;
      let preferredSeats: string[] = [];
      if (queueEntry.selected_seats) {
        try {
          preferredSeats = JSON.parse(queueEntry.selected_seats);
        } catch {}
      }

      if (preferredSeats.length > 0) {
        seatRes = await client.query(
          `SELECT seat_id, label, version 
           FROM seats 
           WHERE event_id = $1 AND status = 'AVAILABLE' AND (label = ANY($2) OR seat_id = ANY($2))
           ORDER BY label ASC 
           LIMIT 1 
           FOR UPDATE`,
          [eventId, preferredSeats]
        );
      }

      if (!seatRes || seatRes.rows.length === 0) {
        seatRes = await client.query(
          `SELECT seat_id, label, version 
           FROM seats 
           WHERE event_id = $1 AND status = 'AVAILABLE' 
           ORDER BY label ASC 
           LIMIT 1 
           FOR UPDATE`,
          [eventId]
        );
      }

      if (seatRes.rows.length === 0) {
        // Check if all seats are SOLD (definitively exhausted)
        const countsRes = await client.query(
          `SELECT 
             COUNT(*) FILTER (WHERE status = 'AVAILABLE') as available_count,
             COUNT(*) FILTER (WHERE status = 'HELD') as held_count,
             COUNT(*) FILTER (WHERE status = 'SOLD') as sold_count,
             COUNT(*) as total_count
           FROM seats WHERE event_id = $1`,
          [eventId]
        );
        const counts = countsRes.rows[0];
        const availableCount = parseInt(counts.available_count, 10);
        const heldCount = parseInt(counts.held_count, 10);

        if (availableCount === 0 && heldCount === 0) {
          // Definitively SOLD OUT: mark remaining WAITING queue entries as SOLD_OUT
          await client.query(
            `UPDATE queue_entries 
             SET status = 'SOLD_OUT', completed_at = NOW() 
             WHERE event_id = $1 AND status = 'WAITING'`,
            [eventId]
          );
          return { assigned: false, isSoldOut: true };
        }

        // Seats are currently HELD by ongoing payments; keep user in queue
        return { assigned: false };
      }

      const seat = seatRes.rows[0];

      // Fetch event price
      const eventRes = await client.query(
        `SELECT price_minor, currency FROM events WHERE event_id = $1`,
        [eventId]
      );
      const priceMinor = eventRes.rows[0].price_minor;
      const currency = eventRes.rows[0].currency;

      // 5. Atomic state transition
      const reservationId = `res_${crypto.randomUUID()}`;
      const assignmentId = `asgn_${crypto.randomUUID()}`;
      const paymentId = `pay_${crypto.randomUUID()}`;
      const deadline = new Date(Date.now() + CONFIG.PAYMENT_TIMEOUT_MS);
      const newGeneration = Number(gateway.generation) + 1;

      // Create PENDING reservation
      await client.query(
        `INSERT INTO reservations (reservation_id, event_id, user_id, seat_id, status, created_at, deadline)
         VALUES ($1, $2, $3, $4, 'PENDING', NOW(), $5)`,
        [reservationId, eventId, queueEntry.user_id, seat.seat_id, deadline]
      );

      // Mark seat HELD
      await client.query(
        `UPDATE seats 
         SET status = 'HELD', current_reservation_id = $1, version = version + 1 
         WHERE seat_id = $2`,
        [reservationId, seat.seat_id]
      );

      // If user selected multiple preferred seats, also hold them under this reservation
      if (preferredSeats.length > 1) {
        await client.query(
          `UPDATE seats 
           SET status = 'HELD', current_reservation_id = $1, version = version + 1 
           WHERE event_id = $2 AND (label = ANY($3) OR seat_id = ANY($3)) AND status = 'AVAILABLE'`,
          [reservationId, eventId, preferredSeats]
        );
      }

      // Mark gateway BUSY
      await client.query(
        `UPDATE payment_gateways 
         SET status = 'BUSY', current_assignment_id = $1, generation = $2, updated_at = NOW() 
         WHERE gateway_id = $3 AND event_id = $4`,
        [assignmentId, newGeneration, gateway.gateway_id, eventId]
      );

      // Create assignment
      await client.query(
        `INSERT INTO assignments (assignment_id, entry_id, gateway_id, gateway_generation, reservation_id, state, started_at, deadline)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', NOW(), $6)`,
        [assignmentId, queueEntry.entry_id, gateway.gateway_id, newGeneration, reservationId, deadline]
      );

      // Mark queue_entry PROCESSING
      await client.query(
        `UPDATE queue_entries 
         SET status = 'PROCESSING', assigned_at = NOW() 
         WHERE entry_id = $1`,
        [queueEntry.entry_id]
      );

      // Insert PENDING payment record
      await client.query(
        `INSERT INTO payments (payment_id, assignment_id, provider_reference, idempotency_key, amount_minor, currency, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')`,
        [
          paymentId,
          assignmentId,
          `sim_ref_${assignmentId}`,
          `idem_${assignmentId}`,
          priceMinor,
          currency,
        ]
      );

      paymentToStart = {
        assignmentId,
        paymentId,
        amountMinor: priceMinor,
        currency,
        gatewayId: gateway.gateway_id,
        eventId,
      };

      return {
        assigned: true,
        assignmentId,
        gatewayId: gateway.gateway_id,
        userId: queueEntry.user_id,
        seatLabel: seat.label,
        queueSequence: Number(queueEntry.queue_sequence),
      };
    });

    // Notify user immediately over WebSocket with zero latency
    if (outcome.assigned) {
      wsManager.sendToUser(eventId, outcome.userId!, {
        type: 'GATEWAY_ASSIGNED',
        assignmentId: outcome.assignmentId,
        gatewayId: outcome.gatewayId,
        seatLabel: outcome.seatLabel,
        queueSequence: outcome.queueSequence,
      });
      wsManager.broadcastToEvent(eventId, {
        type: 'QUEUE_ADVANCED',
        processedSequence: outcome.queueSequence,
      });
    }

    // 6. Non-blocking external simulator launch AFTER commit
    if (outcome.assigned && paymentToStart) {
      this.paymentSimulator.startPayment(paymentToStart);
    }

    return outcome;
  }
}

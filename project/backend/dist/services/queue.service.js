import crypto from 'crypto';
import { getDb } from '../db/connection.js';
export class QueueService {
    db;
    constructor(db) {
        this.db = db;
    }
    async getDatabase() {
        if (!this.db) {
            this.db = await getDb();
        }
        return this.db;
    }
    /**
     * Durably registers a user into the FIFO queue for an event.
     * Enforces idempotency via requestKey and prevents duplicate active entries per user.
     */
    async joinQueue(eventId, userId, idempotencyKey) {
        const db = await this.getDatabase();
        const idemKey = idempotencyKey || `auto_${userId}_${Date.now()}`;
        return await db.withTransaction(async (client) => {
            // Ensure user exists in users table (auto-provision test user)
            await client.query(`INSERT INTO users (user_id, name, email, password_hash)
         VALUES ($1, $2, $3, 'auto_hash')
         ON CONFLICT (user_id) DO NOTHING`, [userId, `User ${userId}`, `${userId}@example.com`]);
            // 1. Check Idempotency Record
            const existingIdem = await client.query(`SELECT response_body FROM idempotency_records 
         WHERE user_id = $1 AND operation = 'JOIN_QUEUE' AND request_key = $2`, [userId, idemKey]);
            if (existingIdem.rows.length > 0 && existingIdem.rows[0].response_body) {
                const parsed = JSON.parse(existingIdem.rows[0].response_body);
                return { ...parsed, isExisting: true };
            }
            // 2. Check if user already has an active entry (WAITING, PROCESSING, RECONCILING)
            const existingEntry = await client.query(`SELECT entry_id, queue_sequence, status, joined_at 
         FROM queue_entries 
         WHERE event_id = $1 AND user_id = $2 
           AND status IN ('WAITING', 'PROCESSING', 'RECONCILING')
         LIMIT 1`, [eventId, userId]);
            if (existingEntry.rows.length > 0) {
                const row = existingEntry.rows[0];
                // Calculate position ahead
                const posRes = await client.query(`SELECT COUNT(*) as ahead FROM queue_entries 
           WHERE event_id = $1 AND status = 'WAITING' AND queue_sequence < $2`, [eventId, row.queue_sequence]);
                const positionAhead = parseInt(posRes.rows[0].ahead, 10);
                const result = {
                    entryId: row.entry_id,
                    queueSequence: Number(row.queue_sequence),
                    status: row.status,
                    positionAhead,
                    joinedAt: new Date(row.joined_at),
                    isExisting: true,
                };
                // Cache response in idempotency
                await client.query(`INSERT INTO idempotency_records (record_id, user_id, operation, request_key, request_hash, result_reference, response_body)
           VALUES ($1, $2, 'JOIN_QUEUE', $3, $4, $5, $6)
           ON CONFLICT (user_id, operation, request_key) DO NOTHING`, [
                    `idem_${crypto.randomUUID()}`,
                    userId,
                    idemKey,
                    crypto.createHash('sha256').update(`${eventId}:${userId}`).digest('hex'),
                    result.entryId,
                    JSON.stringify(result),
                ]);
                return result;
            }
            // 3. Acquire short lock on event_control to allocate next monotonic queue sequence
            const ctrlRes = await client.query(`SELECT next_queue_sequence, dispatch_paused 
         FROM event_control 
         WHERE event_id = $1 
         FOR UPDATE`, [eventId]);
            if (ctrlRes.rows.length === 0) {
                throw new Error(`Event control row not found for event ${eventId}`);
            }
            const seq = Number(ctrlRes.rows[0].next_queue_sequence);
            const newSeq = seq + 1;
            // Update next sequence
            await client.query(`UPDATE event_control SET next_queue_sequence = $1, updated_at = NOW() WHERE event_id = $2`, [newSeq, eventId]);
            // Check current position ahead among WAITING entries
            const posRes = await client.query(`SELECT COUNT(*) as ahead FROM queue_entries 
         WHERE event_id = $1 AND status = 'WAITING'`, [eventId]);
            const positionAhead = parseInt(posRes.rows[0].ahead, 10);
            const entryId = `qentry_${crypto.randomUUID()}`;
            const joinedAt = new Date();
            // Insert new queue entry
            await client.query(`INSERT INTO queue_entries (entry_id, event_id, user_id, attempt_number, queue_sequence, status, joined_at)
         VALUES ($1, $2, $3, 1, $4, 'WAITING', $5)`, [entryId, eventId, userId, seq, joinedAt]);
            const result = {
                entryId,
                queueSequence: seq,
                status: 'WAITING',
                positionAhead,
                joinedAt,
                isExisting: false,
            };
            // Record in idempotency_records
            await client.query(`INSERT INTO idempotency_records (record_id, user_id, operation, request_key, request_hash, result_reference, response_body)
         VALUES ($1, $2, 'JOIN_QUEUE', $3, $4, $5, $6)
         ON CONFLICT (user_id, operation, request_key) DO NOTHING`, [
                `idem_${crypto.randomUUID()}`,
                userId,
                idemKey,
                crypto.createHash('sha256').update(`${eventId}:${userId}`).digest('hex'),
                entryId,
                JSON.stringify(result),
            ]);
            return result;
        });
    }
    /**
     * Retrieves user's latest queue status, assigned gateway, and booking outcome.
     */
    async getQueueStatus(eventId, userId) {
        const db = await this.getDatabase();
        const entryRes = await db.query(`SELECT q.entry_id, q.queue_sequence, q.status, q.joined_at, q.assigned_at, q.completed_at,
              a.assignment_id, a.gateway_id, a.state as assignment_state, a.deadline,
              r.seat_id, s.label as seat_label,
              b.booking_id, b.confirmed_at
       FROM queue_entries q
       LEFT JOIN assignments a ON q.entry_id = a.entry_id
       LEFT JOIN reservations r ON a.reservation_id = r.reservation_id
       LEFT JOIN seats s ON r.seat_id = s.seat_id
       LEFT JOIN bookings b ON r.reservation_id = b.reservation_id
       WHERE q.event_id = $1 AND q.user_id = $2
       ORDER BY q.queue_sequence DESC
       LIMIT 1`, [eventId, userId]);
        if (entryRes.rows.length === 0) {
            return { status: 'NOT_IN_QUEUE', eventId, userId };
        }
        const row = entryRes.rows[0];
        let positionAhead = 0;
        if (row.status === 'WAITING') {
            const posRes = await db.query(`SELECT COUNT(*) as ahead FROM queue_entries 
         WHERE event_id = $1 AND status = 'WAITING' AND queue_sequence < $2`, [eventId, row.queue_sequence]);
            positionAhead = parseInt(posRes.rows[0].ahead, 10);
        }
        return {
            entryId: row.entry_id,
            eventId,
            userId,
            queueSequence: Number(row.queue_sequence),
            status: row.status,
            positionAhead,
            joinedAt: row.joined_at,
            assignedAt: row.assigned_at,
            completedAt: row.completed_at,
            assignment: row.assignment_id
                ? {
                    assignmentId: row.assignment_id,
                    gatewayId: row.gateway_id,
                    state: row.assignment_state,
                    deadline: row.deadline,
                    seatLabel: row.seat_label,
                }
                : null,
            booking: row.booking_id
                ? {
                    bookingId: row.booking_id,
                    seatLabel: row.seat_label,
                    confirmedAt: row.confirmed_at,
                }
                : null,
        };
    }
}

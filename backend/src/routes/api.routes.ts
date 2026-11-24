import { wsManager } from '../services/ws.manager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { QueueService } from '../services/queue.service.js';
import { DispatcherService } from '../services/dispatcher.service.js';
import { ResultHandler } from '../services/result-handler.js';
import { simulator, PaymentResult } from '../services/payment-simulator.js';
import { getDb } from '../db/connection.js';
import { CONFIG } from '../config.js';
import { seedInitialData } from '../db/migrator.js';

export function registerRoutes(
  app: FastifyInstance,
  services: {
    queueService: QueueService;
    dispatcherService: DispatcherService;
    resultHandler: ResultHandler;
  }
) {
  const { queueService, dispatcherService, resultHandler } = services;

  // Helper to extract or fallback user identity
  const getUserId = (req: any): string => {
    return (
      (req.headers['x-user-id'] as string) ||
      (req.headers['authorization']?.replace('Bearer ', '')) ||
      (req.query as any)?.userId ||
      'usr_00001'
    );
  };

  // --- 1. Event Routes ---
  app.get('/events', async (req, reply) => {
    const db = await getDb();
    const res = await db.query(
      `SELECT e.*, 
              (SELECT COUNT(*) FROM seats WHERE event_id = e.event_id AND status = 'AVAILABLE') as available_seats,
              (SELECT COUNT(*) FROM seats WHERE event_id = e.event_id AND status = 'HELD') as held_seats,
              (SELECT COUNT(*) FROM seats WHERE event_id = e.event_id AND status = 'SOLD') as sold_seats,
              (SELECT COUNT(*) FROM queue_entries WHERE event_id = e.event_id AND status = 'WAITING') as waiting_count,
              (SELECT COUNT(*) FROM payment_gateways WHERE event_id = e.event_id AND status = 'FREE') as free_gateways,
              (SELECT COUNT(*) FROM payment_gateways WHERE event_id = e.event_id) as total_gateways
       FROM events e 
       ORDER BY e.created_at ASC`
    );

    return {
      events: res.rows.map((row) => ({
        eventId: row.event_id,
        title: row.title,
        venue: row.venue,
        eventTime: row.event_time,
        totalSeats: row.total_seats,
        priceMinor: row.price_minor,
        currency: row.currency,
        saleStatus: row.sale_status,
        metrics: {
          availableSeats: parseInt(row.available_seats, 10),
          heldSeats: parseInt(row.held_seats, 10),
          soldSeats: parseInt(row.sold_seats, 10),
          waitingQueue: parseInt(row.waiting_count, 10),
          freeGateways: parseInt(row.free_gateways, 10),
          totalGateways: parseInt(row.total_gateways, 10),
        },
      })),
    };
  });

  app.get('/events/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = await getDb();
    const res = await db.query(
      `SELECT e.*, 
              (SELECT COUNT(*) FROM seats WHERE event_id = e.event_id AND status = 'AVAILABLE') as available_seats,
              (SELECT COUNT(*) FROM seats WHERE event_id = e.event_id AND status = 'HELD') as held_seats,
              (SELECT COUNT(*) FROM seats WHERE event_id = e.event_id AND status = 'SOLD') as sold_seats,
              (SELECT COUNT(*) FROM queue_entries WHERE event_id = e.event_id AND status = 'WAITING') as waiting_count,
              (SELECT COUNT(*) FROM payment_gateways WHERE event_id = e.event_id AND status = 'FREE') as free_gateways,
              (SELECT COUNT(*) FROM payment_gateways WHERE event_id = e.event_id) as total_gateways
       FROM events e 
       WHERE e.event_id = $1`,
      [id]
    );

    if (res.rows.length === 0) {
      return reply.code(404).send({ error: 'EVENT_NOT_FOUND', message: `Event ${id} not found` });
    }

    const row = res.rows[0];
    return {
      eventId: row.event_id,
      title: row.title,
      venue: row.venue,
      eventTime: row.event_time,
      totalSeats: row.total_seats,
      priceMinor: row.price_minor,
      currency: row.currency,
      saleStatus: row.sale_status,
      metrics: {
        availableSeats: parseInt(row.available_seats, 10),
        heldSeats: parseInt(row.held_seats, 10),
        soldSeats: parseInt(row.sold_seats, 10),
        waitingQueue: parseInt(row.waiting_count, 10),
        freeGateways: parseInt(row.free_gateways, 10),
        totalGateways: parseInt(row.total_gateways, 10),
      },
    };
  });

  // --- 2. Seat Map & Queue Routes ---
  app.get('/events/:id/seats', async (req, reply) => {
    const { id: eventId } = req.params as { id: string };
    const db = await getDb();
    
    // Order HELD first, then SOLD, then AVAILABLE so held seats are immediately surfaced
    const res = await db.query(
      `SELECT seat_id, label, status, current_reservation_id 
       FROM seats 
       WHERE event_id = $1 
       ORDER BY 
         CASE status 
           WHEN 'HELD' THEN 1 
           WHEN 'SOLD' THEN 2 
           ELSE 3 
         END, 
         label ASC 
       LIMIT 300`,
      [eventId]
    );

    const counts = await db.query(
      `SELECT 
         COUNT(*) as total_seats,
         COUNT(*) FILTER (WHERE status = 'AVAILABLE') as available_seats,
         COUNT(*) FILTER (WHERE status = 'HELD') as held_seats,
         COUNT(*) FILTER (WHERE status = 'SOLD') as sold_seats
       FROM seats WHERE event_id = $1`,
      [eventId]
    );

    const c = counts.rows[0];
    return {
      eventId,
      totalSeats: parseInt(c.total_seats || '0', 10),
      metrics: {
        available: parseInt(c.available_seats || '0', 10),
        held: parseInt(c.held_seats || '0', 10),
        sold: parseInt(c.sold_seats || '0', 10),
      },
      holdDurationSeconds: 300,
      seats: res.rows
    };
  });

  app.post('/events/:id/queue/cancel', async (req, reply) => {
    const { id: eventId } = req.params as { id: string };
    const userId = getUserId(req);
    const db = await getDb();

    const asgnRes = await db.query(
      `SELECT a.assignment_id, a.gateway_id, a.reservation_id, p.payment_id
       FROM assignments a
       JOIN reservations r ON a.reservation_id = r.reservation_id
       LEFT JOIN payments p ON a.assignment_id = p.assignment_id
       WHERE r.event_id = $1 AND r.user_id = $2 AND a.state = 'ACTIVE'
       LIMIT 1`,
      [eventId, userId]
    );

    if (asgnRes.rows.length > 0) {
      const row = asgnRes.rows[0];
      await resultHandler.handlePaymentResult({
        assignmentId: row.assignment_id,
        paymentId: row.payment_id || `pay_${Date.now()}`,
        status: 'CANCELLED',
        providerReference: `user_cancelled_${Date.now()}`,
        providerEventId: `ev_cancel_${Date.now()}`,
        durationMs: 0,
        reason: 'USER_CANCELLED_HOLD',
        signature: 'simulated_sig',
      });
      dispatcherService.triggerDispatch(eventId);
      return { success: true, message: 'Hold cancelled and seats released' };
    }

    return { success: true, message: 'No active hold found' };
  });

  app.post('/events/:id/queue', async (req, reply) => {
    const { id: eventId } = req.params as { id: string };
    const userId = getUserId(req);
    const body = (req.body as any) || {};
    const idempotencyKey =
      (req.headers['idempotency-key'] as string) || body.idempotencyKey;
    const selectedSeats = body.selectedSeats as string[] | undefined;

    try {
      const result = await queueService.joinQueue(eventId, userId, idempotencyKey, selectedSeats);

      // Trigger dispatcher non-blockingly so if any gateway is free, this user is immediately scheduled
      dispatcherService.triggerDispatch(eventId);

      return reply.code(result.isExisting ? 200 : 201).send({
        status: 'ACCEPTED',
        entry: {
          entryId: result.entryId,
          queueSequence: result.queueSequence,
          state: result.status,
          positionAhead: result.positionAhead,
          joinedAt: result.joinedAt,
        },
      });
    } catch (err: any) {
      req.log.error(err);
      return reply.code(500).send({ error: 'QUEUE_JOIN_FAILED', message: err.message });
    }
  });

  app.get('/events/:id/queue/me', async (req, reply) => {
    const { id: eventId } = req.params as { id: string };
    const userId = getUserId(req);

    const status = await queueService.getQueueStatus(eventId, userId);
    return reply.code(200).send(status);
  });

  // --- 3. Assignment Routes ---
  app.get('/assignments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = await getDb();

    const res = await db.query(
      `SELECT a.*, r.user_id, r.seat_id, s.label as seat_label, p.status as payment_status
       FROM assignments a
       JOIN reservations r ON a.reservation_id = r.reservation_id
       JOIN seats s ON r.seat_id = s.seat_id
       LEFT JOIN payments p ON a.assignment_id = p.assignment_id
       WHERE a.assignment_id = $1`,
      [id]
    );

    if (res.rows.length === 0) {
      return reply.code(404).send({ error: 'ASSIGNMENT_NOT_FOUND', message: `Assignment ${id} not found` });
    }

    const row = res.rows[0];
    return {
      assignmentId: row.assignment_id,
      gatewayId: row.gateway_id,
      state: row.state,
      startedAt: row.started_at,
      deadline: row.deadline,
      completedAt: row.completed_at,
      seatLabel: row.seat_label,
      paymentStatus: row.payment_status,
      userId: row.user_id,
    };
  });

  // --- 4. Payment Callback Route ---
  app.post('/payments/callback', async (req, reply) => {
    const body = req.body as PaymentResult;
    const signature = (req.headers['x-signature'] as string) || body.signature;

    if (!signature) {
      return reply.code(400).send({ error: 'SIGNATURE_MISSING', message: 'x-signature header or field is required' });
    }

    const isValid = simulator.verifySignature(body.paymentId, body.status, body.providerReference, signature);
    if (!isValid) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: 'HMAC verification failed' });
    }

    const outcome = await resultHandler.handlePaymentResult(body);
    return reply.code(200).send({ received: true, ...outcome });
  });

  // Direct payment submission from Payment Page
  app.post('/payments/submit', async (req, reply) => {
    const body = (req.body as any) || {};
    const assignmentId = body.assignmentId;
    const outcome = body.outcome === 'FAILED' ? 'FAILED' : 'SUCCESS';

    const db = await getDb();
    const assignInfo = await db.query(
      `SELECT a.assignment_id, p.payment_id, p.provider_reference 
       FROM assignments a
       JOIN payments p ON a.assignment_id = p.assignment_id
       WHERE a.assignment_id = $1`,
      [assignmentId]
    );

    if (assignInfo.rows.length === 0) {
      return reply.code(404).send({ error: 'ASSIGNMENT_NOT_FOUND', message: `Assignment ${assignmentId} not found` });
    }

    const pay = assignInfo.rows[0];
    const provRef = pay.provider_reference || `sim_sub_${Date.now()}`;
    const result: PaymentResult = {
      assignmentId,
      paymentId: pay.payment_id,
      status: outcome,
      providerReference: provRef,
      providerEventId: `ev_submit_${Date.now()}`,
      durationMs: 50,
      reason: outcome === 'FAILED' ? 'PAYMENT_DECLINED_BY_USER' : undefined,
      signature: simulator.generateSignature(pay.payment_id, outcome, provRef),
    };

    const res = await resultHandler.handlePaymentResult(result);
    return reply.code(200).send({ received: true, ...res, outcome });
  });

  // --- 5. Bookings Routes ---
  app.get('/me/bookings', async (req, reply) => {
    const userId = getUserId(req);
    const db = await getDb();

    const res = await db.query(
      `SELECT b.booking_id, b.confirmed_at, s.label as seat_label, e.title as event_title, e.event_time, e.venue
       FROM bookings b
       JOIN seats s ON b.seat_id = s.seat_id
       JOIN events e ON s.event_id = e.event_id
       WHERE b.user_id = $1
       ORDER BY b.confirmed_at DESC`,
      [userId]
    );

    return { bookings: res.rows };
  });

  // User Profile & Booking Stats
  app.get('/me/profile', async (req, reply) => {
    const userId = getUserId(req);
    const db = await getDb();

    const [userRes, attemptsRes, bookingsRes] = await Promise.all([
      db.query(`SELECT user_id, name, email, created_at FROM users WHERE user_id = $1`, [userId]),
      db.query(
        `SELECT 
           COUNT(*) as total_attempts,
           COUNT(*) FILTER (WHERE status = 'CONFIRMED') as confirmed_count,
           COUNT(*) FILTER (WHERE status = 'FAILED') as failed_count,
           COUNT(*) FILTER (WHERE status IN ('WAITING', 'PROCESSING')) as in_progress_count
         FROM queue_entries WHERE user_id = $1`,
        [userId]
      ),
      db.query(
        `SELECT b.booking_id, b.confirmed_at, s.label as seat_label, e.title as event_title, e.event_time, e.venue, p.amount_minor, p.currency
         FROM bookings b
         JOIN seats s ON b.seat_id = s.seat_id
         JOIN events e ON s.event_id = e.event_id
         JOIN payments p ON b.payment_id = p.payment_id
         WHERE b.user_id = $1
         ORDER BY b.confirmed_at DESC`,
        [userId]
      ),
    ]);

    const urow = userRes.rows[0] || { user_id: userId, name: `User ${userId}`, email: `${userId}@example.com` };
    const arow = attemptsRes.rows[0] || {};
    const totalAttempts = parseInt(arow.total_attempts || '0', 10);
    const confirmedCount = parseInt(arow.confirmed_count || '0', 10);
    const failedCount = parseInt(arow.failed_count || '0', 10);
    const inProgressCount = parseInt(arow.in_progress_count || '0', 10);
    const successRate = totalAttempts > 0 ? ((confirmedCount / totalAttempts) * 100).toFixed(1) : '0.0';

    return {
      user: urow,
      stats: {
        totalAttempts,
        confirmedCount,
        failedCount,
        inProgressCount,
        successRate: `${successRate}%`,
      },
      bookings: bookingsRes.rows,
    };
  });

  app.get('/bookings/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = await getDb();

    const res = await db.query(
      `SELECT b.booking_id, b.user_id, b.confirmed_at, s.label as seat_label, e.title as event_title, e.event_time, e.venue, p.amount_minor, p.currency
       FROM bookings b
       JOIN seats s ON b.seat_id = s.seat_id
       JOIN events e ON s.event_id = e.event_id
       JOIN payments p ON b.payment_id = p.payment_id
       WHERE b.booking_id = $1`,
      [id]
    );

    if (res.rows.length === 0) {
      return reply.code(404).send({ error: 'BOOKING_NOT_FOUND', message: `Booking ${id} not found` });
    }

    return res.rows[0];
  });

  // --- 6. Admin & Monitoring Dashboard Routes ---
  app.get('/admin/dashboard', async (req, reply) => {
    const eventId = (req.query as any)?.eventId || CONFIG.DEFAULT_EVENT_ID;
    const db = await getDb();

    const [eventRes, gwRes, queueRes, recentBookings] = await Promise.all([
      db.query(
        `SELECT 
           (SELECT COUNT(*) FROM seats WHERE event_id = $1 AND status = 'AVAILABLE') as available_seats,
           (SELECT COUNT(*) FROM seats WHERE event_id = $1 AND status = 'HELD') as held_seats,
           (SELECT COUNT(*) FROM seats WHERE event_id = $1 AND status = 'SOLD') as sold_seats,
           (SELECT COUNT(*) FROM seats WHERE event_id = $1) as total_seats,
           (SELECT next_queue_sequence FROM event_control WHERE event_id = $1) as next_seq,
           (SELECT dispatch_paused FROM event_control WHERE event_id = $1) as dispatch_paused`,
        [eventId]
      ),
      db.query(
        `SELECT gateway_id, status, current_assignment_id, generation, updated_at
         FROM payment_gateways
         WHERE event_id = $1
         ORDER BY gateway_id ASC`,
        [eventId]
      ),
      db.query(
        `SELECT 
           COUNT(*) FILTER (WHERE status = 'WAITING') as waiting_count,
           COUNT(*) FILTER (WHERE status = 'PROCESSING') as processing_count,
           COUNT(*) FILTER (WHERE status = 'CONFIRMED') as confirmed_count,
           COUNT(*) FILTER (WHERE status = 'FAILED') as failed_count,
           COUNT(*) FILTER (WHERE status = 'SOLD_OUT') as sold_out_count,
           COUNT(*) as total_entries
         FROM queue_entries WHERE event_id = $1`,
        [eventId]
      ),
      db.query(
        `SELECT b.booking_id, b.user_id, s.label as seat_label, b.confirmed_at 
         FROM bookings b
         JOIN seats s ON b.seat_id = s.seat_id
         WHERE s.event_id = $1
         ORDER BY b.confirmed_at DESC LIMIT 10`,
        [eventId]
      ),
    ]);

    const erow = eventRes.rows[0] || {};
    const qrow = queueRes.rows[0] || {};

    return {
      nodeId: CONFIG.NODE_ID,
      eventId,
      dispatchPaused: !!erow.dispatch_paused,
      seats: {
        total: parseInt(erow.total_seats || '0', 10),
        available: parseInt(erow.available_seats || '0', 10),
        held: parseInt(erow.held_seats || '0', 10),
        sold: parseInt(erow.sold_seats || '0', 10),
      },
      gateways: gwRes.rows.map((g) => ({
        gatewayId: g.gateway_id,
        status: g.status,
        currentAssignmentId: g.current_assignment_id,
        generation: Number(g.generation),
        updatedAt: g.updated_at,
      })),
      queue: {
        waiting: parseInt(qrow.waiting_count || '0', 10),
        processing: parseInt(qrow.processing_count || '0', 10),
        confirmed: parseInt(qrow.confirmed_count || '0', 10),
        failed: parseInt(qrow.failed_count || '0', 10),
        soldOut: parseInt(qrow.sold_out_count || '0', 10),
        total: parseInt(qrow.total_entries || '0', 10),
      },
      recentBookings: recentBookings.rows,
    };
  });

  app.post('/admin/dispatch/pause', async (req, reply) => {
    const eventId = (req.body as any)?.eventId || CONFIG.DEFAULT_EVENT_ID;
    const db = await getDb();
    await db.query(`UPDATE event_control SET dispatch_paused = TRUE WHERE event_id = $1`, [eventId]);
    return { success: true, dispatchPaused: true };
  });

  app.post('/admin/dispatch/resume', async (req, reply) => {
    const eventId = (req.body as any)?.eventId || CONFIG.DEFAULT_EVENT_ID;
    const db = await getDb();
    await db.query(`UPDATE event_control SET dispatch_paused = FALSE WHERE event_id = $1`, [eventId]);
    dispatcherService.triggerDispatch(eventId);
    return { success: true, dispatchPaused: false };
  });

  app.post('/admin/simulation/configure', async (req, reply) => {
    const body = req.body as any;
    simulator.configure({
      successRate: body.successRate,
      minLatency: body.minLatency,
      maxLatency: body.maxLatency,
    });
    return { success: true, message: 'Simulator configuration updated' };
  });

  app.post('/admin/reset', async (req, reply) => {
    const body = (req.body as any) || {};
    const db = await getDb();
    const eventId = body.eventId || CONFIG.DEFAULT_EVENT_ID;
    const seatCount = body.seatCount || 20; // Default small count for reset/test
    const gatewayCount = body.gatewayCount || 3;

    await db.withTransaction(async (client) => {
      await client.query(`DELETE FROM bookings WHERE reservation_id IN (SELECT reservation_id FROM reservations WHERE event_id = $1)`, [eventId]);
      await client.query(`DELETE FROM callback_receipts`);
      await client.query(`DELETE FROM payments WHERE assignment_id IN (SELECT assignment_id FROM assignments WHERE reservation_id IN (SELECT reservation_id FROM reservations WHERE event_id = $1))`, [eventId]);
      await client.query(`DELETE FROM assignments WHERE reservation_id IN (SELECT reservation_id FROM reservations WHERE event_id = $1)`, [eventId]);
      await client.query(`DELETE FROM reservations WHERE event_id = $1`, [eventId]);
      await client.query(`DELETE FROM queue_entries WHERE event_id = $1`, [eventId]);
      await client.query(`DELETE FROM idempotency_records`);
      await client.query(`DELETE FROM seats WHERE event_id = $1`, [eventId]);
      await client.query(`DELETE FROM payment_gateways WHERE event_id = $1`, [eventId]);
      await client.query(`UPDATE event_control SET next_queue_sequence = 1, dispatch_paused = FALSE WHERE event_id = $1`, [eventId]);
    });

    await seedInitialData(db, { seatCount, gatewayCount, userCount: 200 });

    return { success: true, message: `System reset for ${eventId} with ${seatCount} seats and ${gatewayCount} gateways.` };
  });


  // --- WebSocket Real-Time Queue & Pre-Queue Route ---
  app.get('/ws/events/:id/queue', { websocket: true }, (connection: any, req: any) => {
    const { id: eventId } = req.params as { id: string };
    const query = (req.query as any) || {};
    const userId = (req.headers['x-user-id'] as string) || query.userId || 'usr_00001';

    const socket = connection.socket || connection;
    wsManager.register(eventId, userId, socket);

    // Push initial status immediately over WebSocket
    queueService.getQueueStatus(eventId, userId).then((status) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'QUEUE_STATUS', data: status }));
      }
    }).catch(console.error);

    socket.on('message', async (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'PING') {
          socket.send(JSON.stringify({ type: 'PONG' }));
        } else if (msg.type === 'GET_STATUS') {
          const status = await queueService.getQueueStatus(eventId, userId);
          socket.send(JSON.stringify({ type: 'QUEUE_STATUS', data: status }));
        }
      } catch (e) {}
    });
  });

  // Trigger Drop Shuffle for Pre-Queue Waiting Room
  app.post('/events/:id/drop', async (req, reply) => {
    const { id: eventId } = req.params as { id: string };
    try {
      const res = await queueService.executeDropShuffle(eventId);
      wsManager.broadcastToEvent(eventId, {
        type: 'DROP_SHUFFLE_COMPLETE',
        eventId,
        shuffledCount: res.shuffledCount,
      });
      dispatcherService.triggerDispatch(eventId);
      return reply.code(200).send({
        success: true,
        message: `Ticket drop initiated! Shuffled ${res.shuffledCount} waiting room users.`,
        ...res,
      });
    } catch (err: any) {
      return reply.code(500).send({ error: 'DROP_FAILED', message: err.message });
    }
  });

  // Healthcheck endpoint
  app.get('/health', async () => {
    return { status: 'OK', nodeId: CONFIG.NODE_ID, time: new Date().toISOString() };
  });

  // UI Web Dashboard & Ticket Booking interface
  const serveFrontend = (reply: any) => {
    const candidates = [
      path.resolve(process.cwd(), 'frontend/index.html'),
      path.resolve(process.cwd(), '../frontend/index.html'),
      path.resolve(__dirname, '../../../frontend/index.html'),
      path.resolve(__dirname, '../../../../frontend/index.html'),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) {
      reply.type('text/html').send(fs.readFileSync(found, 'utf8'));
    } else {
      reply.send({ status: 'OK', message: 'Concert Booking Backend API Online' });
    }
  };

  app.get('/', async (req, reply) => serveFrontend(reply));
  app.get('/dashboard', async (req, reply) => serveFrontend(reply));
}

import assert from 'assert';
import { createServer } from '../src/server.js';
import { CONFIG } from '../src/config.js';
import { getDb } from '../src/db/connection.js';
import { simulator } from '../src/services/payment-simulator.js';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('====================================================');
  console.log('  RUNNING CONCERT BOOKING SYSTEM VERIFICATION SUITE ');
  console.log('====================================================\n');

  // Configure simulator for fast, deterministic unit test execution
  simulator.configure({
    successRate: 1.0, // 100% success for baseline FIFO/seat uniqueness test
    minLatency: 10,
    maxLatency: 30,
  });

  const { server, queueService, dispatcherService, resultHandler, recoveryWorker } = await createServer();
  const db = await getDb();

  const testEventId = 'evt_test_suite_01';
  const totalSeats = 15;
  const fixedGateways = 3;

  console.log(`[Test Setup] Initializing test event '${testEventId}' with ${totalSeats} seats and ${fixedGateways} gateways...`);
  
  // Clean setup
  await db.withTransaction(async (client) => {
    await client.query(`DELETE FROM bookings`);
    await client.query(`DELETE FROM callback_receipts`);
    await client.query(`DELETE FROM payments`);
    await client.query(`DELETE FROM assignments`);
    await client.query(`DELETE FROM reservations`);
    await client.query(`DELETE FROM queue_entries`);
    await client.query(`DELETE FROM idempotency_records`);
    await client.query(`DELETE FROM seats WHERE event_id = $1`, [testEventId]);
    await client.query(`DELETE FROM payment_gateways WHERE event_id = $1`, [testEventId]);
    await client.query(`DELETE FROM event_control WHERE event_id = $1`, [testEventId]);
    await client.query(`DELETE FROM events WHERE event_id = $1`, [testEventId]);

    await client.query(
      `INSERT INTO events (event_id, title, venue, event_time, total_seats, price_minor, currency, sale_status)
       VALUES ($1, 'Test Tour', 'Arena', NOW(), $2, 10000, 'USD', 'ACTIVE')`,
      [testEventId, totalSeats]
    );

    await client.query(
      `INSERT INTO event_control (event_id, next_queue_sequence, dispatch_paused)
       VALUES ($1, 1, FALSE)`,
      [testEventId]
    );

    for (let g = 1; g <= fixedGateways; g++) {
      await client.query(
        `INSERT INTO payment_gateways (gateway_id, event_id, status, generation, updated_at)
         VALUES ($1, $2, 'FREE', 0, NOW())`,
        [g, testEventId]
      );
    }

    for (let s = 1; s <= totalSeats; s++) {
      const seatId = `seat_test_${s.toString().padStart(3, '0')}`;
      const label = `SEAT-${s.toString().padStart(3, '0')}`;
      await client.query(
        `INSERT INTO seats (seat_id, event_id, label, status, version)
         VALUES ($1, $2, $3, 'AVAILABLE', 0)`,
        [seatId, testEventId, label]
      );
    }

    for (let u = 1; u <= 30; u++) {
      const uid = `usr_test_${u.toString().padStart(3, '0')}`;
      await client.query(
        `INSERT INTO users (user_id, name, email, password_hash)
         VALUES ($1, $2, $3, 'hash')
         ON CONFLICT (user_id) DO NOTHING`,
        [uid, `User ${u}`, `user_${u}@test.com`]
      );
    }
  });

  console.log('[Test Setup] Done.\n');

  // ---------------------------------------------------------
  // TEST 1: Strict FIFO Sequencing & Idempotency
  // ---------------------------------------------------------
  console.log('TEST 1: Strict FIFO Queue Sequencing & Idempotent Joins...');
  const user1 = 'usr_test_001';
  const idemKey1 = 'key_user1_join_abc';

  const join1 = await queueService.joinQueue(testEventId, user1, idemKey1);
  assert.strictEqual(join1.queueSequence, 1, 'First user must have sequence 1');
  assert.strictEqual(join1.status, 'WAITING', 'First user must start in WAITING');

  // Re-joining with same idempotency key must return exact same sequence
  const join1Replay = await queueService.joinQueue(testEventId, user1, idemKey1);
  assert.strictEqual(join1Replay.queueSequence, 1, 'Replayed join must return sequence 1');
  assert.strictEqual(join1Replay.entryId, join1.entryId, 'Replayed join must return same entryId');

  // Another user joining must get sequence 2
  const user2 = 'usr_test_002';
  const join2 = await queueService.joinQueue(testEventId, user2, 'key_user2_join');
  assert.strictEqual(join2.queueSequence, 2, 'Second user must have sequence 2');

  console.log('✓ TEST 1 PASSED: Strict FIFO sequencing and idempotency verified.\n');

  // ---------------------------------------------------------
  // TEST 2: Fixed Gateway Capacity Limit
  // ---------------------------------------------------------
  console.log('TEST 2: Fixed Payment Gateway Concurrency Cap...');
  // Queue 5 more users (users 3 to 7)
  for (let u = 3; u <= 7; u++) {
    await queueService.joinQueue(testEventId, `usr_test_${u.toString().padStart(3, '0')}`);
  }

  // Trigger dispatch
  dispatcherService.triggerDispatch(testEventId);

  // Give brief moment for dispatch to run
  await sleep(10);

  // Check gateways: busy count MUST NEVER exceed fixedGateways (3)
  const gwCheck = await db.query(
    `SELECT COUNT(*) as busy_count FROM payment_gateways WHERE event_id = $1 AND status = 'BUSY'`,
    [testEventId]
  );
  const busyCount = parseInt(gwCheck.rows[0].busy_count, 10);
  assert(busyCount <= fixedGateways, `Busy gateways (${busyCount}) must not exceed limit (${fixedGateways})`);
  console.log(`✓ TEST 2 PASSED: Active gateways bounded by capacity (${busyCount} <= ${fixedGateways}).\n`);

  // ---------------------------------------------------------
  // TEST 3: Drain Queue to Completion & Verify Invariants
  // ---------------------------------------------------------
  console.log('TEST 3: Drain Queue & Verify Correctness Invariants (No Duplicates, Valid Payments)...');

  // Wait for all 7 queued users to complete simulated payment
  let allDone = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const qCount = await db.query(
      `SELECT 
         COUNT(*) FILTER (WHERE status = 'WAITING') as waiting,
         COUNT(*) FILTER (WHERE status = 'PROCESSING') as processing
       FROM queue_entries WHERE event_id = $1`,
      [testEventId]
    );
    const waiting = parseInt(qCount.rows[0].waiting, 10);
    const processing = parseInt(qCount.rows[0].processing, 10);
    if (waiting === 0 && processing === 0) {
      allDone = true;
      break;
    }
    await sleep(50);
  }
  assert(allDone, 'All 7 users should have finished queue & payment');

  // Invariant 1: No duplicate seats confirmed
  const dupSeats = await db.query(
    `SELECT seat_id, COUNT(*) as cnt FROM bookings GROUP BY seat_id HAVING COUNT(*) > 1`
  );
  assert.strictEqual(dupSeats.rows.length, 0, 'Zero duplicate seat allocations allowed');

  // Invariant 2: Every confirmed booking has matching successful payment
  const unverifiedBookings = await db.query(
    `SELECT b.booking_id, p.status 
     FROM bookings b 
     JOIN payments p ON b.payment_id = p.payment_id 
     WHERE p.status != 'SUCCESS'`
  );
  assert.strictEqual(unverifiedBookings.rows.length, 0, 'Every booking must correspond to SUCCESS payment');

  // Invariant 3: Seat balance reconciliation: AVAILABLE + HELD + SOLD = totalSeats
  const seatCounts = await db.query(
    `SELECT 
       COUNT(*) FILTER (WHERE status = 'AVAILABLE') as available,
       COUNT(*) FILTER (WHERE status = 'HELD') as held,
       COUNT(*) FILTER (WHERE status = 'SOLD') as sold,
       COUNT(*) as total
     FROM seats WHERE event_id = $1`,
    [testEventId]
  );
  const avail = parseInt(seatCounts.rows[0].available, 10);
  const held = parseInt(seatCounts.rows[0].held, 10);
  const sold = parseInt(seatCounts.rows[0].sold, 10);
  const total = parseInt(seatCounts.rows[0].total, 10);
  assert.strictEqual(avail + held + sold, total, 'Seat counts must reconcile: AVAILABLE + HELD + SOLD = total');
  assert.strictEqual(sold, 7, 'All 7 queued users must have confirmed tickets');
  assert.strictEqual(avail, totalSeats - 7, 'Remaining seats must equal available');

  console.log(`✓ TEST 3 PASSED: Verified 0 duplicate seats, exact payment match, inventory reconciled (${avail} avail, ${sold} sold).\n`);

  // ---------------------------------------------------------
  // TEST 4: Payment Failure & Seat Release
  // ---------------------------------------------------------
  console.log('TEST 4: Payment Failure & Automatic Seat Release...');
  // Force 100% failure in simulator for next user
  simulator.configure({
    successRate: 0.0,
    minLatency: 10,
    maxLatency: 20,
  });

  const failUser = 'usr_test_010';
  await queueService.joinQueue(testEventId, failUser);
  dispatcherService.triggerDispatch(testEventId);

  // Wait for failure completion
  await sleep(150);

  const failEntry = await db.query(
    `SELECT status FROM queue_entries WHERE event_id = $1 AND user_id = $2`,
    [testEventId, failUser]
  );
  assert.strictEqual(failEntry.rows[0].status, 'FAILED', 'Queue entry must be marked FAILED');

  // Verify that the held seat was safely released back to AVAILABLE
  const seatReconcile = await db.query(
    `SELECT 
       COUNT(*) FILTER (WHERE status = 'AVAILABLE') as available,
       COUNT(*) FILTER (WHERE status = 'SOLD') as sold
     FROM seats WHERE event_id = $1`,
    [testEventId]
  );
  assert.strictEqual(parseInt(seatReconcile.rows[0].sold, 10), 7, 'Sold count should remain 7 after failed payment');
  assert.strictEqual(parseInt(seatReconcile.rows[0].available, 10), totalSeats - 7, 'Held seat must be released to AVAILABLE');

  console.log('✓ TEST 4 PASSED: Failed payment safely released held seat.\n');

  // ---------------------------------------------------------
  // TEST 5: Recovery Worker - Reconciling Stalled Assignments
  // ---------------------------------------------------------
  console.log('TEST 5: Recovery Worker & Stalled Assignment Reconciliation...');
  // Pause dispatch and create a synthetic expired assignment
  const stallUser = 'usr_test_011';
  await db.query(`UPDATE event_control SET dispatch_paused = TRUE WHERE event_id = $1`, [testEventId]);

  const joinStall = await queueService.joinQueue(testEventId, stallUser);
  const freeSeat = (await db.query(`SELECT seat_id FROM seats WHERE event_id = $1 AND status = 'AVAILABLE' LIMIT 1`, [testEventId])).rows[0];

  const synResId = 'res_syn_01';
  const synAsgnId = 'asgn_syn_01';
  const synPayId = 'pay_syn_01';
  const pastDeadline = new Date(Date.now() - 10000); // 10s in the past

  await db.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO reservations (reservation_id, event_id, user_id, seat_id, status, created_at, deadline)
       VALUES ($1, $2, $3, $4, 'PENDING', NOW() - INTERVAL '20s', $5)`,
      [synResId, testEventId, stallUser, freeSeat.seat_id, pastDeadline]
    );
    await client.query(
      `UPDATE seats SET status = 'HELD', current_reservation_id = $1 WHERE seat_id = $2`,
      [synResId, freeSeat.seat_id]
    );
    await client.query(
      `UPDATE payment_gateways SET status = 'BUSY', current_assignment_id = $1 WHERE gateway_id = 1 AND event_id = $2`,
      [synAsgnId, testEventId]
    );
    await client.query(
      `INSERT INTO assignments (assignment_id, entry_id, gateway_id, gateway_generation, reservation_id, state, started_at, deadline)
       VALUES ($1, $2, 1, 99, $3, 'ACTIVE', NOW() - INTERVAL '20s', $4)`,
      [synAsgnId, joinStall.entryId, synResId, pastDeadline]
    );
    await client.query(
      `INSERT INTO payments (payment_id, assignment_id, provider_reference, idempotency_key, amount_minor, currency, status)
       VALUES ($1, $2, 'syn_ref', 'syn_idem', 10000, 'USD', 'PENDING')`,
      [synPayId, synAsgnId]
    );
  });

  // Run recovery cycle
  const recOutcome = await recoveryWorker.runRecoveryCycle();
  assert(recOutcome.recoveredCount >= 1, 'Recovery worker must recover stalled assignment');

  // Verify gateway is freed and seat is released
  const gw1 = await db.query(`SELECT status FROM payment_gateways WHERE gateway_id = 1 AND event_id = $1`, [testEventId]);
  assert.strictEqual(gw1.rows[0].status, 'FREE', 'Gateway 1 must be freed after recovery');

  const seatCheck = await db.query(`SELECT status FROM seats WHERE seat_id = $1`, [freeSeat.seat_id]);
  assert.strictEqual(seatCheck.rows[0].status, 'AVAILABLE', 'Seat must be released back to AVAILABLE');

  console.log('✓ TEST 5 PASSED: Recovery worker recovered stalled assignment and freed gateway.\n');

  console.log('====================================================');
  console.log('  ALL CORRECTNESS & INVARIANT TESTS PASSED (5/5)    ');
  console.log('====================================================\n');

  try {
    await db.close();
  } catch {}
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});

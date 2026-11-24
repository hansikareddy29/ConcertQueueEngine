import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './connection.js';
import { CONFIG } from '../config.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export async function runMigrations(db) {
    const database = db || (await getDb());
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    // Split and execute statements
    console.log('[Migration] Applying schema definitions...');
    const statements = schemaSql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    for (const statement of statements) {
        try {
            await database.query(statement);
        }
        catch (err) {
            // Ignore already exists or harmless notices
            if (!err.message?.includes('already exists')) {
                console.warn(`[Migration Warning] Statement error: ${err.message}`);
            }
        }
    }
    console.log('[Migration] Schema migration completed successfully.');
}
export async function seedInitialData(db, options) {
    const database = db || (await getDb());
    const seatCount = options?.seatCount ?? CONFIG.TOTAL_SEATS;
    const gatewayCount = options?.gatewayCount ?? CONFIG.DEFAULT_GATEWAY_COUNT;
    const userCount = options?.userCount ?? 500;
    const eventId = CONFIG.DEFAULT_EVENT_ID;
    console.log(`[Seed] Seeding event '${eventId}' with ${seatCount} seats, ${gatewayCount} gateways, ${userCount} users...`);
    await database.withTransaction(async (client) => {
        // 1. Seed or update event
        await client.query(`INSERT INTO events (event_id, title, venue, event_time, total_seats, price_minor, currency, sale_status)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', $4, $5, $6, 'ACTIVE')
       ON CONFLICT (event_id) DO UPDATE SET
         total_seats = EXCLUDED.total_seats,
         price_minor = EXCLUDED.price_minor,
         sale_status = 'ACTIVE'`, [eventId, 'Global Rock Fest 2026', 'National Arena', seatCount, 15000, 'USD']);
        // 2. Seed event_control
        await client.query(`INSERT INTO event_control (event_id, next_queue_sequence, dispatch_paused)
       VALUES ($1, 1, FALSE)
       ON CONFLICT (event_id) DO NOTHING`, [eventId]);
        // 3. Seed Fixed Payment Gateways
        for (let gid = 1; gid <= gatewayCount; gid++) {
            await client.query(`INSERT INTO payment_gateways (gateway_id, event_id, status, generation, updated_at)
         VALUES ($1, $2, 'FREE', 0, NOW())
         ON CONFLICT (gateway_id, event_id) DO NOTHING`, [gid, eventId]);
        }
        // 4. Seed Seats in batches for efficiency
        const existingSeats = await client.query(`SELECT COUNT(*) as count FROM seats WHERE event_id = $1`, [eventId]);
        const existingCount = parseInt(existingSeats.rows[0].count, 10);
        if (existingCount < seatCount) {
            console.log(`[Seed] Generating seats ${existingCount + 1} to ${seatCount}...`);
            const batchSize = 1000;
            for (let i = existingCount + 1; i <= seatCount; i += batchSize) {
                const end = Math.min(i + batchSize - 1, seatCount);
                const values = [];
                const placeholders = [];
                let pIdx = 1;
                for (let s = i; s <= end; s++) {
                    const seatId = `seat_${eventId}_${s.toString().padStart(5, '0')}`;
                    const label = `SEAT-${s.toString().padStart(5, '0')}`;
                    placeholders.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, 'AVAILABLE', 0)`);
                    values.push(seatId, eventId, label);
                }
                const insertSeatsSql = `
          INSERT INTO seats (seat_id, event_id, label, status, version)
          VALUES ${placeholders.join(', ')}
          ON CONFLICT (event_id, label) DO NOTHING;
        `;
                await client.query(insertSeatsSql, values);
            }
        }
        // 5. Seed test users
        console.log(`[Seed] Generating ${userCount} test user accounts...`);
        const userBatchSize = 250;
        for (let i = 1; i <= userCount; i += userBatchSize) {
            const end = Math.min(i + userBatchSize - 1, userCount);
            const values = [];
            const placeholders = [];
            let pIdx = 1;
            for (let u = i; u <= end; u++) {
                const userId = `usr_${u.toString().padStart(5, '0')}`;
                const name = `Test Fan ${u}`;
                const email = `user_${u}@example.com`;
                placeholders.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, 'seeded_hash')`);
                values.push(userId, name, email);
            }
            const insertUsersSql = `
        INSERT INTO users (user_id, name, email, password_hash)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (user_id) DO NOTHING;
      `;
            await client.query(insertUsersSql, values);
        }
    });
    console.log('[Seed] Seeding completed.');
}

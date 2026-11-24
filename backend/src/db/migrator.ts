import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, IDatabase } from './connection.js';
import { CONFIG } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(db?: IDatabase): Promise<void> {
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
    } catch (err: any) {
      // Ignore already exists or harmless notices
      if (!err.message?.includes('already exists')) {
        console.warn(`[Migration Warning] Statement error: ${err.message}`);
      }
    }
  }
  console.log('[Migration] Schema migration completed successfully.');
}

export async function seedInitialData(
  db?: IDatabase,
  options?: { seatCount?: number; gatewayCount?: number; userCount?: number }
): Promise<void> {
  const database = db || (await getDb());
  const seatCount = options?.seatCount ?? CONFIG.TOTAL_SEATS;
  const gatewayCount = options?.gatewayCount ?? CONFIG.DEFAULT_GATEWAY_COUNT;
  const userCount = options?.userCount ?? 500;

  const eventsToSeed = [
    {
      id: CONFIG.DEFAULT_EVENT_ID,
      title: 'Global Rock Fest 2026',
      venue: 'National Arena, New York',
      totalSeats: seatCount,
      priceMinor: 15000,
      gateways: gatewayCount,
      daysOffset: 30,
    },
    {
      id: 'evt_coldplay_2026',
      title: 'Coldplay: Music of the Spheres Tour',
      venue: 'Wembley Stadium, London',
      totalSeats: Math.min(seatCount, 2500),
      priceMinor: 12500,
      gateways: 4,
      daysOffset: 45,
    },
    {
      id: 'evt_taylor_2026',
      title: 'Taylor Swift: The Eras Tour (Encore)',
      venue: 'SoFi Stadium, Los Angeles',
      totalSeats: Math.min(seatCount, 3000),
      priceMinor: 22000,
      gateways: 5,
      daysOffset: 60,
    },
    {
      id: 'evt_electronic_2026',
      title: 'Neon Horizon Electronic Odyssey',
      venue: 'Bayfront Park, Miami',
      totalSeats: Math.min(seatCount, 1500),
      priceMinor: 8500,
      gateways: 3,
      daysOffset: 15,
    },
  ];

  console.log(`[Seed] Seeding ${eventsToSeed.length} events...`);

  await database.withTransaction(async (client) => {
    for (const evt of eventsToSeed) {
      // 1. Seed or update event
      await client.query(
        `INSERT INTO events (event_id, title, venue, event_time, total_seats, price_minor, currency, sale_status)
         VALUES ($1, $2, $3, NOW() + ($4 || ' days')::INTERVAL, $5, $6, 'USD', 'ACTIVE')
         ON CONFLICT (event_id) DO UPDATE SET
           total_seats = EXCLUDED.total_seats,
           price_minor = EXCLUDED.price_minor,
           sale_status = 'ACTIVE'`,
        [evt.id, evt.title, evt.venue, evt.daysOffset, evt.totalSeats, evt.priceMinor]
      );

      // 2. Seed event_control
      await client.query(
        `INSERT INTO event_control (event_id, next_queue_sequence, dispatch_paused)
         VALUES ($1, 1, FALSE)
         ON CONFLICT (event_id) DO NOTHING`,
        [evt.id]
      );

      // 3. Seed Fixed Payment Gateways
      for (let gid = 1; gid <= evt.gateways; gid++) {
        await client.query(
          `INSERT INTO payment_gateways (gateway_id, event_id, status, generation, updated_at)
           VALUES ($1, $2, 'FREE', 0, NOW())
           ON CONFLICT (gateway_id, event_id) DO NOTHING`,
          [gid, evt.id]
        );
      }

      // 4. Seed Seats in batches for efficiency
      const existingSeats = await client.query(
        `SELECT COUNT(*) as count FROM seats WHERE event_id = $1`,
        [evt.id]
      );
      const existingCount = parseInt(existingSeats.rows[0].count, 10);

      if (existingCount < evt.totalSeats) {
        console.log(`[Seed] Generating seats for ${evt.id} (${existingCount + 1} to ${evt.totalSeats})...`);
        const batchSize = 1000;
        for (let i = existingCount + 1; i <= evt.totalSeats; i += batchSize) {
          const end = Math.min(i + batchSize - 1, evt.totalSeats);
          const values: any[] = [];
          const placeholders: string[] = [];

          let pIdx = 1;
          for (let s = i; s <= end; s++) {
            const seatId = `seat_${evt.id}_${s.toString().padStart(5, '0')}`;
            const label = `SEAT-${s.toString().padStart(5, '0')}`;
            placeholders.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, 'AVAILABLE', 0)`);
            values.push(seatId, evt.id, label);
          }

          const insertSeatsSql = `
            INSERT INTO seats (seat_id, event_id, label, status, version)
            VALUES ${placeholders.join(', ')}
            ON CONFLICT (event_id, label) DO NOTHING;
          `;
          await client.query(insertSeatsSql, values);
        }
      }
    }

    // 5. Seed test users
    console.log(`[Seed] Generating ${userCount} test user accounts...`);
    const userBatchSize = 250;
    for (let i = 1; i <= userCount; i += userBatchSize) {
      const end = Math.min(i + userBatchSize - 1, userCount);
      const values: any[] = [];
      const placeholders: string[] = [];
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

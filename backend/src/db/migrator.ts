// BookMyShow-style auditorium tiers and labels definition
export interface AuditoriumRowConfig {
  row: string;
  count: number;
  aisleAfter: number;
  tierName: string;
  priceFactor: number;
  color: string;
}

export function generateEventAuditoriumConfig(eventId: string, totalSeats: number): AuditoriumRowConfig[] {
  const ROW_LETTERS = [
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q',
    'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'AA', 'BB', 'CC'
  ];

  let rowCount = 20;
  let seatsPerRow = 25;
  let aisleAfter = 12;

  if (totalSeats === 1000) {
    rowCount = 25;
    seatsPerRow = 40;
    aisleAfter = 20;
  } else if (totalSeats === 750) {
    rowCount = 25;
    seatsPerRow = 30;
    aisleAfter = 15;
  } else if (totalSeats === 500) {
    rowCount = 20;
    seatsPerRow = 25;
    aisleAfter = 12;
  } else if (totalSeats === 400) {
    rowCount = 16;
    seatsPerRow = 25;
    aisleAfter = 12;
  } else {
    rowCount = Math.max(10, Math.floor(totalSeats / 25));
    seatsPerRow = Math.ceil(totalSeats / rowCount);
    aisleAfter = Math.floor(seatsPerRow / 2);
  }

  const rows: AuditoriumRowConfig[] = [];
  let remainingSeats = totalSeats;

  for (let rIdx = 0; rIdx < rowCount && remainingSeats > 0; rIdx++) {
    const rowLetter = ROW_LETTERS[rIdx] || `R${rIdx + 1}`;
    const thisRowCount = Math.min(seatsPerRow, remainingSeats);
    const thisAisle = Math.min(aisleAfter, Math.floor(thisRowCount / 2));

    let tierName = 'SILVER CLUB';
    let priceFactor = 0.75;
    let color = '#94a3b8';

    const progress = rIdx / rowCount;
    if (progress < 0.2) {
      tierName = 'VIP RECLINERS';
      priceFactor = 1.5;
      color = '#fbbf24';
    } else if (progress < 0.45) {
      tierName = 'PRIME PLATINUM';
      priceFactor = 1.25;
      color = '#818cf8';
    } else if (progress < 0.7) {
      tierName = 'GOLD EXECUTIVE';
      priceFactor = 1.0;
      color = '#34d399';
    }

    rows.push({
      row: rowLetter,
      count: thisRowCount,
      aisleAfter: thisAisle,
      tierName,
      priceFactor,
      color,
    });
    remainingSeats -= thisRowCount;
  }

  return rows;
}

export function getEventSeatLabels(eventId: string, totalSeats: number): string[] {
  const rows = generateEventAuditoriumConfig(eventId, totalSeats);
  const labels: string[] = [];
  for (const r of rows) {
    for (let i = 1; i <= r.count; i++) {
      labels.push(`${r.row}-${i.toString().padStart(2, '0')}`);
    }
  }
  return labels;
}

export function getBookMyShowSeatLabels(): string[] {
  return getEventSeatLabels('default', 500);
}

// Backward-compatible alias
export function getCircularSeatLabels(): string[] {
  return getBookMyShowSeatLabels();
}

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

  // Ensure columns for temporary real-time holds exist
  try {
    await database.query(`ALTER TABLE seats ADD COLUMN IF NOT EXISTS temporary_hold_user_id VARCHAR(64);`);
    await database.query(`ALTER TABLE seats ADD COLUMN IF NOT EXISTS temporary_hold_until TIMESTAMP WITH TIME ZONE;`);
  } catch (err: any) {}

  console.log('[Migration] Schema migration completed successfully.');
}

export async function seedInitialData(
  db?: IDatabase,
  options?: { seatCount?: number; gatewayCount?: number; userCount?: number }
): Promise<void> {
  const database = db || (await getDb());
  const gatewayCount = options?.gatewayCount ?? CONFIG.DEFAULT_GATEWAY_COUNT;
  const userCount = options?.userCount ?? 500;

  const eventsToSeed = [
    {
      id: CONFIG.DEFAULT_EVENT_ID,
      title: 'Global Rock Fest 2026',
      venue: 'DY Patil Stadium, Mumbai',
      totalSeats: 500,
      priceMinor: 250000, // ₹2,500.00
      currency: 'INR',
      gateways: gatewayCount,
      daysOffset: 30,
      saleStatus: 'ACTIVE',
    },
    {
      id: 'evt_coldplay_2026',
      title: 'Coldplay: Music of the Spheres Tour',
      venue: 'Narendra Modi Stadium, Ahmedabad',
      totalSeats: 750,
      priceMinor: 450000, // ₹4,500.00
      currency: 'INR',
      gateways: 4,
      daysOffset: 45,
      saleStatus: 'ACTIVE',
    },
    {
      id: 'evt_taylor_2026',
      title: 'Taylor Swift: The Eras Tour (Encore)',
      venue: 'Jawaharlal Nehru Stadium, Delhi',
      totalSeats: 1000,
      priceMinor: 750000, // ₹7,500.00
      currency: 'INR',
      gateways: 5,
      daysOffset: 60,
      saleStatus: 'ACTIVE',
    },
    {
      id: 'evt_electronic_2026',
      title: 'Neon Horizon Electronic Odyssey',
      venue: 'Sunburn Arena, Goa',
      totalSeats: 400,
      priceMinor: 180000, // ₹1,800.00
      currency: 'INR',
      gateways: 3,
      daysOffset: 15,
      saleStatus: 'ACTIVE',
    },
  ];

  console.log(`[Seed] Seeding ${eventsToSeed.length} events...`);

  await database.withTransaction(async (client) => {
    for (const evt of eventsToSeed) {
      const status = (evt as any).saleStatus || 'ACTIVE';
      // 1. Seed or update event with INR
      await client.query(
        `INSERT INTO events (event_id, title, venue, event_time, total_seats, price_minor, currency, sale_status)
         VALUES ($1, $2, $3, NOW() + ($4 || ' days')::INTERVAL, $5, $6, $7, $8)
         ON CONFLICT (event_id) DO UPDATE SET
           title = EXCLUDED.title,
           venue = EXCLUDED.venue,
           total_seats = EXCLUDED.total_seats,
           price_minor = EXCLUDED.price_minor,
           currency = EXCLUDED.currency,
           sale_status = EXCLUDED.sale_status`,
        [evt.id, evt.title, evt.venue, evt.daysOffset, evt.totalSeats, evt.priceMinor, evt.currency, status]
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

      // 4. Ensure EXACT matching auditorium seats exist for this event
      const eventLabels = getEventSeatLabels(evt.id, evt.totalSeats);
      console.log(`[Seed] Generating ${eventLabels.length} exact auditorium seats for ${evt.id}...`);

      // Clear any outdated seats for this event so counts match exactly
      await client.query(`DELETE FROM seats WHERE event_id = $1`, [evt.id]);

      const batchSize = 250;
      for (let i = 0; i < eventLabels.length; i += batchSize) {
        const batch = eventLabels.slice(i, i + batchSize);
        const placeholders: string[] = [];
        const values: any[] = [];
        let pIdx = 1;

        for (const lbl of batch) {
          const sid = `seat_${evt.id}_${lbl}`;
          placeholders.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, 'AVAILABLE', 0)`);
          values.push(sid, evt.id, lbl);
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

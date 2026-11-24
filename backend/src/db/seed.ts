import { getDb } from './connection.js';
import { runMigrations, seedInitialData } from './migrator.js';

async function run() {
  const db = await getDb();
  await runMigrations(db);
  await seedInitialData(db);
  console.log('Seed finished successfully.');
  await db.close();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

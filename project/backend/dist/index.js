import { createServer } from './server.js';
import { CONFIG } from './config.js';
import { seedInitialData } from './db/migrator.js';
import { getDb } from './db/connection.js';
async function main() {
    console.log(`[Bootstrap] Starting Concert Booking Backend Node [${CONFIG.NODE_ID}]...`);
    const { server, recoveryWorker, dispatcherService } = await createServer();
    // Seed default data if not present
    const db = await getDb();
    await seedInitialData(db);
    // Start background recovery worker
    recoveryWorker.start(CONFIG.RECOVERY_INTERVAL_MS);
    // Check if any backlog exists and kick off dispatch
    dispatcherService.triggerDispatch(CONFIG.DEFAULT_EVENT_ID);
    try {
        const address = await server.listen({ port: CONFIG.PORT, host: CONFIG.HOST });
        console.log(`[Bootstrap] Server listening at ${address}`);
    }
    catch (err) {
        server.log.error(err);
        process.exit(1);
    }
}
main().catch((err) => {
    console.error('[Bootstrap Fatal Error]:', err);
    process.exit(1);
});

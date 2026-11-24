import Fastify from 'fastify';
import cors from '@fastify/cors';
import { getDb } from './db/connection.js';
import { runMigrations } from './db/migrator.js';
import { QueueService } from './services/queue.service.js';
import { DispatcherService } from './services/dispatcher.service.js';
import { ResultHandler } from './services/result-handler.js';
import { simulator } from './services/payment-simulator.js';
import { RecoveryWorker } from './services/recovery.worker.js';
import { registerRoutes } from './routes/api.routes.js';
export async function createServer() {
    const server = Fastify({
        logger: process.env.NODE_ENV === 'test' ? false : { level: 'info' },
    });
    await server.register(cors, {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'x-signature', 'x-user-id'],
    });
    // Initialize DB and Migrations
    const db = await getDb();
    await runMigrations(db);
    // Initialize core domain services
    const queueService = new QueueService(db);
    const dispatcherService = new DispatcherService(db, simulator);
    const resultHandler = new ResultHandler(db);
    // Wire callback between result handler and dispatcher
    resultHandler.setOnCapacityFreed((eventId) => {
        dispatcherService.triggerDispatch(eventId);
    });
    // Wire simulator callbacks directly to result handler
    simulator.setCallbackHandler(async (result) => {
        await resultHandler.handlePaymentResult(result);
    });
    // Initialize recovery worker
    const recoveryWorker = new RecoveryWorker(db, resultHandler, dispatcherService);
    // Register HTTP routes
    registerRoutes(server, {
        queueService,
        dispatcherService,
        resultHandler,
    });
    return {
        server,
        queueService,
        dispatcherService,
        resultHandler,
        recoveryWorker,
    };
}

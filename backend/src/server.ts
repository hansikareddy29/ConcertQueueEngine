import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { CONFIG } from './config.js';
import { getDb } from './db/connection.js';
import { runMigrations, seedInitialData } from './db/migrator.js';
import { QueueService } from './services/queue.service.js';
import { DispatcherService } from './services/dispatcher.service.js';
import { ResultHandler } from './services/result-handler.js';
import { simulator } from './services/payment-simulator.js';
import { RecoveryWorker } from './services/recovery.worker.js';
import { registerRoutes } from './routes/api.routes.js';

export interface AppContext {
  server: FastifyInstance;
  queueService: QueueService;
  dispatcherService: DispatcherService;
  resultHandler: ResultHandler;
  recoveryWorker: RecoveryWorker;
}

export async function createServer(): Promise<AppContext> {
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

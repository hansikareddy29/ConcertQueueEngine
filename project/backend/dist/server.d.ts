import { FastifyInstance } from 'fastify';
import { QueueService } from './services/queue.service.js';
import { DispatcherService } from './services/dispatcher.service.js';
import { ResultHandler } from './services/result-handler.js';
import { RecoveryWorker } from './services/recovery.worker.js';
export interface AppContext {
    server: FastifyInstance;
    queueService: QueueService;
    dispatcherService: DispatcherService;
    resultHandler: ResultHandler;
    recoveryWorker: RecoveryWorker;
}
export declare function createServer(): Promise<AppContext>;

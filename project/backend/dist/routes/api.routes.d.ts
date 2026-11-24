import { FastifyInstance } from 'fastify';
import { QueueService } from '../services/queue.service.js';
import { DispatcherService } from '../services/dispatcher.service.js';
import { ResultHandler } from '../services/result-handler.js';
export declare function registerRoutes(app: FastifyInstance, services: {
    queueService: QueueService;
    dispatcherService: DispatcherService;
    resultHandler: ResultHandler;
}): void;

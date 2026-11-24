import { IDatabase } from '../db/connection.js';
export interface JoinQueueResult {
    entryId: string;
    queueSequence: number;
    status: string;
    positionAhead: number;
    joinedAt: Date;
    isExisting: boolean;
}
export declare class QueueService {
    private db?;
    constructor(db?: IDatabase | undefined);
    private getDatabase;
    /**
     * Durably registers a user into the FIFO queue for an event.
     * Enforces idempotency via requestKey and prevents duplicate active entries per user.
     */
    joinQueue(eventId: string, userId: string, idempotencyKey?: string): Promise<JoinQueueResult>;
    /**
     * Retrieves user's latest queue status, assigned gateway, and booking outcome.
     */
    getQueueStatus(eventId: string, userId: string): Promise<any>;
}

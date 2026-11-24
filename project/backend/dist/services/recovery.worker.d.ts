import { IDatabase } from '../db/connection.js';
import { ResultHandler } from './result-handler.js';
import { DispatcherService } from './dispatcher.service.js';
export declare class RecoveryWorker {
    private db?;
    private resultHandler?;
    private dispatcher?;
    private timer;
    private isRunning;
    constructor(db?: IDatabase | undefined, resultHandler?: ResultHandler | undefined, dispatcher?: DispatcherService | undefined);
    private getDatabase;
    start(intervalMs?: number): void;
    stop(): void;
    /**
     * Executes a single reconciliation and recovery sweep per Section 11 of HLD.
     */
    runRecoveryCycle(): Promise<{
        recoveredCount: number;
        orphanedGatewaysFreed: number;
    }>;
}

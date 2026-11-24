import { IDatabase } from '../db/connection.js';
import { PaymentResult } from './payment-simulator.js';
export declare class ResultHandler {
    private db?;
    private onCapacityFreed?;
    constructor(db?: IDatabase | undefined, onCapacityFreed?: ((eventId: string) => void) | undefined);
    private getDatabase;
    setOnCapacityFreed(callback: (eventId: string) => void): void;
    /**
     * Handles payment verification result in one atomic transaction per Section 10 & 11.
     * Lock order: event_control -> payment_gateways -> assignments -> reservations/seats
     */
    handlePaymentResult(result: PaymentResult): Promise<{
        success: boolean;
        eventId?: string;
    }>;
}

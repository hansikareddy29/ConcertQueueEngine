import { IDatabase } from '../db/connection.js';
export interface DispatchOutcome {
    assigned: boolean;
    assignmentId?: string;
    gatewayId?: number;
    userId?: string;
    seatLabel?: string;
    queueSequence?: number;
    isSoldOut?: boolean;
}
export declare class DispatcherService {
    private db?;
    private paymentSimulator;
    private isDispatching;
    private pendingTriggers;
    constructor(db?: IDatabase | undefined, paymentSimulator?: import("./payment-simulator.js").PaymentSimulator);
    private getDatabase;
    /**
     * Signals that new capacity or a new queue entry arrived.
     * Debounces execution so consecutive triggers batch effectively without racing.
     */
    triggerDispatch(eventId?: string): void;
    private runDispatchLoop;
    /**
     * Performs ONE atomic assignment per Section 7, 10 of HLD:
     * 1. Lock event_control (ensures dispatch not paused and serializes dispatcher steps)
     * 2. Find and lock next FREE payment_gateway
     * 3. Find and lock oldest FIFO queue_entry with status = 'WAITING'
     * 4. Find and lock next AVAILABLE seat
     * 5. Atomically transition states:
     *    - reservation -> PENDING
     *    - seat -> HELD
     *    - gateway -> BUSY, generation++
     *    - queue_entry -> PROCESSING
     *    - payment -> PENDING
     * 6. Commit transaction (row locks released!).
     * 7. Trigger Payment Simulator outside transaction.
     */
    dispatchNext(eventId: string): Promise<DispatchOutcome>;
}

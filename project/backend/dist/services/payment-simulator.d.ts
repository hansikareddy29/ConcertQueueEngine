export interface PaymentAttemptRequest {
    assignmentId: string;
    paymentId: string;
    amountMinor: number;
    currency: string;
    gatewayId: number;
    eventId: string;
}
export interface PaymentResult {
    assignmentId: string;
    paymentId: string;
    status: 'SUCCESS' | 'FAILED' | 'CANCELLED';
    providerReference: string;
    providerEventId: string;
    durationMs: number;
    reason?: string;
    signature: string;
}
export type PaymentCallbackHandler = (result: PaymentResult) => Promise<void>;
export declare class PaymentSimulator {
    private inFlight;
    private callbackHandler;
    private successRate;
    private minLatency;
    private maxLatency;
    constructor();
    setCallbackHandler(handler: PaymentCallbackHandler): void;
    configure(options: {
        successRate?: number;
        minLatency?: number;
        maxLatency?: number;
    }): void;
    generateSignature(paymentId: string, status: string, providerRef: string): string;
    verifySignature(paymentId: string, status: string, providerRef: string, signature: string): boolean;
    /**
     * Starts an asynchronous payment attempt outside the DB transaction.
     */
    startPayment(attempt: PaymentAttemptRequest): void;
    /**
     * Authoritative status lookup for recovery worker reconciliation.
     */
    getStatus(assignmentId: string): {
        status: string;
        providerReference?: string;
    } | null;
    /**
     * Authoritative cancellation: Atomically wins or loses against payment completion.
     */
    cancelPayment(assignmentId: string): boolean;
}
export declare const simulator: PaymentSimulator;

import crypto from 'crypto';
import { CONFIG } from '../config.js';
export class PaymentSimulator {
    inFlight = new Map();
    callbackHandler = null;
    successRate = CONFIG.SIMULATOR_SUCCESS_RATE;
    minLatency = CONFIG.SIMULATOR_MIN_LATENCY_MS;
    maxLatency = CONFIG.SIMULATOR_MAX_LATENCY_MS;
    constructor() { }
    setCallbackHandler(handler) {
        this.callbackHandler = handler;
    }
    configure(options) {
        if (options.successRate !== undefined)
            this.successRate = Math.max(0, Math.min(1, options.successRate));
        if (options.minLatency !== undefined)
            this.minLatency = Math.max(1, options.minLatency);
        if (options.maxLatency !== undefined)
            this.maxLatency = Math.max(this.minLatency, options.maxLatency);
    }
    generateSignature(paymentId, status, providerRef) {
        return crypto
            .createHmac('sha256', CONFIG.CALLBACK_SECRET)
            .update(`${paymentId}:${status}:${providerRef}`)
            .digest('hex');
    }
    verifySignature(paymentId, status, providerRef, signature) {
        const expected = this.generateSignature(paymentId, status, providerRef);
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    }
    /**
     * Starts an asynchronous payment attempt outside the DB transaction.
     */
    startPayment(attempt) {
        const { assignmentId, paymentId, gatewayId } = attempt;
        // Deterministic outcome or seeded probability
        const isSuccess = Math.random() < this.successRate;
        const duration = Math.floor(Math.random() * (this.maxLatency - this.minLatency + 1)) + this.minLatency;
        const providerReference = `sim_tx_${crypto.randomUUID()}`;
        const entry = {
            assignmentId,
            paymentId,
            gatewayId,
            status: 'PROCESSING',
            providerReference,
            durationMs: duration,
        };
        const timer = setTimeout(async () => {
            // If already cancelled or finished, ignore
            if (entry.status !== 'PROCESSING')
                return;
            entry.status = isSuccess ? 'SUCCESS' : 'FAILED';
            const providerEventId = `ev_${crypto.randomUUID()}`;
            const signature = this.generateSignature(paymentId, entry.status, providerReference);
            const result = {
                assignmentId,
                paymentId,
                status: entry.status,
                providerReference,
                providerEventId,
                durationMs: duration,
                reason: isSuccess ? undefined : 'INSUFFICIENT_FUNDS_OR_DECLINED',
                signature,
            };
            this.inFlight.delete(assignmentId);
            if (this.callbackHandler) {
                try {
                    await this.callbackHandler(result);
                }
                catch (err) {
                    console.error(`[Simulator Callback Error] Error in callback handler for assignment ${assignmentId}:`, err);
                }
            }
        }, duration);
        entry.timerHandle = timer;
        this.inFlight.set(assignmentId, entry);
    }
    /**
     * Authoritative status lookup for recovery worker reconciliation.
     */
    getStatus(assignmentId) {
        const entry = this.inFlight.get(assignmentId);
        if (!entry)
            return null;
        return { status: entry.status, providerReference: entry.providerReference };
    }
    /**
     * Authoritative cancellation: Atomically wins or loses against payment completion.
     */
    cancelPayment(assignmentId) {
        const entry = this.inFlight.get(assignmentId);
        if (!entry)
            return false;
        if (entry.status === 'PROCESSING') {
            if (entry.timerHandle)
                clearTimeout(entry.timerHandle);
            entry.status = 'CANCELLED';
            this.inFlight.delete(assignmentId);
            return true;
        }
        return false;
    }
}
export const simulator = new PaymentSimulator();

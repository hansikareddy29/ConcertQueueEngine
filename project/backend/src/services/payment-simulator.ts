import crypto from 'crypto';
import { CONFIG } from '../config.js';

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

interface SimulatorEntry {
  assignmentId: string;
  paymentId: string;
  gatewayId: number;
  status: 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  providerReference: string;
  durationMs: number;
  timerHandle?: NodeJS.Timeout;
}

export class PaymentSimulator {
  private inFlight = new Map<string, SimulatorEntry>();
  private callbackHandler: PaymentCallbackHandler | null = null;
  private successRate = CONFIG.SIMULATOR_SUCCESS_RATE;
  private minLatency = CONFIG.SIMULATOR_MIN_LATENCY_MS;
  private maxLatency = CONFIG.SIMULATOR_MAX_LATENCY_MS;

  constructor() {}

  setCallbackHandler(handler: PaymentCallbackHandler) {
    this.callbackHandler = handler;
  }

  configure(options: { successRate?: number; minLatency?: number; maxLatency?: number }) {
    if (options.successRate !== undefined) this.successRate = Math.max(0, Math.min(1, options.successRate));
    if (options.minLatency !== undefined) this.minLatency = Math.max(1, options.minLatency);
    if (options.maxLatency !== undefined) this.maxLatency = Math.max(this.minLatency, options.maxLatency);
  }

  generateSignature(paymentId: string, status: string, providerRef: string): string {
    return crypto
      .createHmac('sha256', CONFIG.CALLBACK_SECRET)
      .update(`${paymentId}:${status}:${providerRef}`)
      .digest('hex');
  }

  verifySignature(paymentId: string, status: string, providerRef: string, signature: string): boolean {
    const expected = this.generateSignature(paymentId, status, providerRef);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  /**
   * Starts an asynchronous payment attempt outside the DB transaction.
   */
  startPayment(attempt: PaymentAttemptRequest): void {
    const { assignmentId, paymentId, gatewayId } = attempt;

    // Deterministic outcome or seeded probability
    const isSuccess = Math.random() < this.successRate;
    const duration = Math.floor(Math.random() * (this.maxLatency - this.minLatency + 1)) + this.minLatency;
    const providerReference = `sim_tx_${crypto.randomUUID()}`;

    const entry: SimulatorEntry = {
      assignmentId,
      paymentId,
      gatewayId,
      status: 'PROCESSING',
      providerReference,
      durationMs: duration,
    };

    const timer = setTimeout(async () => {
      // If already cancelled or finished, ignore
      if (entry.status !== 'PROCESSING') return;

      entry.status = isSuccess ? 'SUCCESS' : 'FAILED';
      const providerEventId = `ev_${crypto.randomUUID()}`;
      const signature = this.generateSignature(paymentId, entry.status, providerReference);

      const result: PaymentResult = {
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
        } catch (err: any) {
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
  getStatus(assignmentId: string): { status: string; providerReference?: string } | null {
    const entry = this.inFlight.get(assignmentId);
    if (!entry) return null;
    return { status: entry.status, providerReference: entry.providerReference };
  }

  /**
   * Authoritative cancellation: Atomically wins or loses against payment completion.
   */
  cancelPayment(assignmentId: string): boolean {
    const entry = this.inFlight.get(assignmentId);
    if (!entry) return false;
    if (entry.status === 'PROCESSING') {
      if (entry.timerHandle) clearTimeout(entry.timerHandle);
      entry.status = 'CANCELLED';
      this.inFlight.delete(assignmentId);
      return true;
    }
    return false;
  }
}

export const simulator = new PaymentSimulator();

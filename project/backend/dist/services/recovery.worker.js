import { getDb } from '../db/connection.js';
import { CONFIG } from '../config.js';
import { simulator } from './payment-simulator.js';
export class RecoveryWorker {
    db;
    resultHandler;
    dispatcher;
    timer = null;
    isRunning = false;
    constructor(db, resultHandler, dispatcher) {
        this.db = db;
        this.resultHandler = resultHandler;
        this.dispatcher = dispatcher;
    }
    async getDatabase() {
        if (!this.db) {
            this.db = await getDb();
        }
        return this.db;
    }
    start(intervalMs = CONFIG.RECOVERY_INTERVAL_MS) {
        if (this.timer)
            return;
        console.log(`[RecoveryWorker] Started with check interval ${intervalMs}ms.`);
        this.timer = setInterval(() => {
            this.runRecoveryCycle().catch((err) => {
                console.error('[RecoveryWorker Error] Cycle error:', err);
            });
        }, intervalMs);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /**
     * Executes a single reconciliation and recovery sweep per Section 11 of HLD.
     */
    async runRecoveryCycle() {
        if (this.isRunning)
            return { recoveredCount: 0, orphanedGatewaysFreed: 0 };
        this.isRunning = true;
        let recoveredCount = 0;
        let orphanedGatewaysFreed = 0;
        try {
            const db = await this.getDatabase();
            // 1. Find stalled assignments past deadline
            const stalled = await db.query(`SELECT a.assignment_id, a.gateway_id, a.reservation_id, a.deadline, p.payment_id
         FROM assignments a
         LEFT JOIN payments p ON a.assignment_id = p.assignment_id
         WHERE a.state = 'ACTIVE' AND a.deadline < NOW()
         LIMIT 50`);
            for (const row of stalled.rows) {
                console.log(`[RecoveryWorker] Stalled assignment detected: ${row.assignment_id}`);
                // Check simulator status
                const simStatus = simulator.getStatus(row.assignment_id);
                if (simStatus && simStatus.status === 'SUCCESS') {
                    // Simulator finished as SUCCESS, complete confirmation
                    if (this.resultHandler) {
                        await this.resultHandler.handlePaymentResult({
                            assignmentId: row.assignment_id,
                            paymentId: row.payment_id,
                            status: 'SUCCESS',
                            providerReference: simStatus.providerReference || `sim_rec_${Date.now()}`,
                            providerEventId: `ev_rec_${Date.now()}`,
                            durationMs: 0,
                            signature: simulator.generateSignature(row.payment_id, 'SUCCESS', simStatus.providerReference || ''),
                        });
                        recoveredCount++;
                    }
                }
                else {
                    // Terminal failure: Cancel on simulator and release
                    simulator.cancelPayment(row.assignment_id);
                    if (this.resultHandler) {
                        await this.resultHandler.handlePaymentResult({
                            assignmentId: row.assignment_id,
                            paymentId: row.payment_id,
                            status: 'CANCELLED',
                            providerReference: `sim_timeout_${Date.now()}`,
                            providerEventId: `ev_timeout_${Date.now()}`,
                            durationMs: 0,
                            reason: 'GATEWAY_TIMEOUT_RECONCILED',
                            signature: simulator.generateSignature(row.payment_id, 'CANCELLED', `sim_timeout_${Date.now()}`),
                        });
                        recoveredCount++;
                    }
                }
            }
            // 2. Identify orphaned BUSY gateways (gateway marked BUSY but assignment is not ACTIVE)
            const orphaned = await db.query(`SELECT g.gateway_id, g.event_id, g.current_assignment_id
         FROM payment_gateways g
         LEFT JOIN assignments a ON g.current_assignment_id = a.assignment_id
         WHERE g.status = 'BUSY' AND (g.current_assignment_id IS NULL OR a.state NOT IN ('ACTIVE', 'RECONCILING'))`);
            for (const og of orphaned.rows) {
                console.warn(`[RecoveryWorker] Freeing orphaned gateway ${og.gateway_id} for event ${og.event_id}`);
                await db.query(`UPDATE payment_gateways 
           SET status = 'FREE', current_assignment_id = NULL, updated_at = NOW() 
           WHERE gateway_id = $1 AND event_id = $2`, [og.gateway_id, og.event_id]);
                orphanedGatewaysFreed++;
            }
            // 3. If any capacity was recovered or freed, trigger dispatch
            if ((recoveredCount > 0 || orphanedGatewaysFreed > 0) && this.dispatcher) {
                this.dispatcher.triggerDispatch();
            }
        }
        catch (err) {
            console.error('[RecoveryWorker] Error during recovery cycle:', err);
        }
        finally {
            this.isRunning = false;
        }
        return { recoveredCount, orphanedGatewaysFreed };
    }
}

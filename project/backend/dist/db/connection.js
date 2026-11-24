import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { CONFIG } from '../config.js';
const { Pool } = pg;
let dbInstance = null;
export async function getDb() {
    if (dbInstance)
        return dbInstance;
    if (CONFIG.DATABASE_URL && CONFIG.DATABASE_URL.trim() !== '') {
        console.log(`[DB] Connecting to PostgreSQL at ${CONFIG.DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
        const pool = new Pool({
            connectionString: CONFIG.DATABASE_URL,
            max: CONFIG.MAX_DB_POOL_SIZE,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });
        // Test connection
        try {
            const test = await pool.query('SELECT 1 as test');
            console.log('[DB] Connected to PostgreSQL successfully.');
            dbInstance = {
                isPGlite: false,
                query: async (sql, params) => {
                    const res = await pool.query(sql, params);
                    return { rows: res.rows, rowCount: res.rowCount ?? 0 };
                },
                getClient: async () => {
                    const client = await pool.connect();
                    return {
                        query: async (sql, params) => {
                            const res = await client.query(sql, params);
                            return { rows: res.rows, rowCount: res.rowCount ?? 0 };
                        },
                        release: () => client.release(),
                    };
                },
                withTransaction: async (callback) => {
                    const client = await pool.connect();
                    try {
                        await client.query('BEGIN');
                        const result = await callback({
                            query: async (sql, params) => {
                                const res = await client.query(sql, params);
                                return { rows: res.rows, rowCount: res.rowCount ?? 0 };
                            },
                        });
                        await client.query('COMMIT');
                        return result;
                    }
                    catch (err) {
                        await client.query('ROLLBACK');
                        throw err;
                    }
                    finally {
                        client.release();
                    }
                },
                close: async () => {
                    await pool.end();
                },
            };
            return dbInstance;
        }
        catch (err) {
            console.warn(`[DB] Could not connect to PostgreSQL (${err.message}). Falling back to embedded PGlite.`);
        }
    }
    // Fallback to PGlite (Real in-process WASM PostgreSQL)
    console.log('[DB] Initializing embedded PGlite (WASM PostgreSQL 16)...');
    const pglite = new PGlite();
    await pglite.waitReady;
    console.log('[DB] Embedded PGlite initialized successfully.');
    let inTx = false;
    // Transaction lock queue for PGlite single-connection transactions
    let txQueue = Promise.resolve();
    dbInstance = {
        isPGlite: true,
        query: async (sql, params) => {
            const res = await pglite.query(sql, params);
            return { rows: res.rows, rowCount: res.rows.length };
        },
        getClient: async () => {
            return {
                query: async (sql, params) => {
                    const res = await pglite.query(sql, params);
                    return { rows: res.rows, rowCount: res.rows.length };
                },
                release: () => { },
            };
        },
        withTransaction: async (callback) => {
            // Serialize transactions in PGlite so nested or concurrent async operations don't collide
            return new Promise((resolve, reject) => {
                txQueue = txQueue.then(async () => {
                    try {
                        await pglite.query('BEGIN');
                        const result = await callback({
                            query: async (sql, params) => {
                                const res = await pglite.query(sql, params);
                                return { rows: res.rows, rowCount: res.rows.length };
                            },
                        });
                        await pglite.query('COMMIT');
                        resolve(result);
                    }
                    catch (err) {
                        try {
                            await pglite.query('ROLLBACK');
                        }
                        catch { }
                        reject(err);
                    }
                }).catch(reject);
            });
        },
        close: async () => {
            try {
                await pglite.close();
            }
            catch (e) {
                // Suppress wasm shutdown noise
            }
        },
    };
    return dbInstance;
}

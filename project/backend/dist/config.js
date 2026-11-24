export const CONFIG = {
    PORT: parseInt(process.env.PORT || '4000', 10),
    HOST: process.env.HOST || '0.0.0.0',
    DATABASE_URL: process.env.DATABASE_URL || '',
    DEFAULT_GATEWAY_COUNT: parseInt(process.env.GATEWAY_COUNT || '3', 10),
    DEFAULT_EVENT_ID: process.env.DEFAULT_EVENT_ID || 'evt_concert_2026',
    TOTAL_SEATS: parseInt(process.env.TOTAL_SEATS || '20000', 10),
    PAYMENT_TIMEOUT_MS: parseInt(process.env.PAYMENT_TIMEOUT_MS || '5000', 10),
    RECOVERY_INTERVAL_MS: parseInt(process.env.RECOVERY_INTERVAL_MS || '3000', 10),
    SIMULATOR_SUCCESS_RATE: parseFloat(process.env.SIMULATOR_SUCCESS_RATE || '0.90'),
    SIMULATOR_MIN_LATENCY_MS: parseInt(process.env.SIMULATOR_MIN_LATENCY_MS || '50', 10),
    SIMULATOR_MAX_LATENCY_MS: parseInt(process.env.SIMULATOR_MAX_LATENCY_MS || '250', 10),
    CALLBACK_SECRET: process.env.CALLBACK_SECRET || 'sim_secret_key_2026',
    MAX_DB_POOL_SIZE: parseInt(process.env.MAX_DB_POOL_SIZE || '30', 10),
    NODE_ID: process.env.NODE_ID || `node_${Math.random().toString(36).substring(2, 7)}`
};

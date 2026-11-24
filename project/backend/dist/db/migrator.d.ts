import { IDatabase } from './connection.js';
export declare function runMigrations(db?: IDatabase): Promise<void>;
export declare function seedInitialData(db?: IDatabase, options?: {
    seatCount?: number;
    gatewayCount?: number;
    userCount?: number;
}): Promise<void>;

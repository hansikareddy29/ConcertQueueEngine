export interface IDbClient {
    query<T = any>(sql: string, params?: any[]): Promise<{
        rows: T[];
        rowCount: number;
    }>;
    release?(): void;
}
export interface IDatabase {
    query<T = any>(sql: string, params?: any[]): Promise<{
        rows: T[];
        rowCount: number;
    }>;
    withTransaction<T>(callback: (client: IDbClient) => Promise<T>): Promise<T>;
    getClient(): Promise<IDbClient>;
    close(): Promise<void>;
    isPGlite: boolean;
}
export declare function getDb(): Promise<IDatabase>;

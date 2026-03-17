import { Pool, PoolConfig } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
    if (!pool) {
        const connString = (process.env.DATABASE_URL || '').trim();
        console.log('DB connection string length:', connString.length);
        const config: PoolConfig = {
            connectionString: connString,
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        };
        pool = new Pool(config);
    }
    return pool;
}

export function setPool(customPool: Pool): void {
    pool = customPool;
}

export async function closePool(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

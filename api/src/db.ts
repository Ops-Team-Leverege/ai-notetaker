import { Pool, PoolConfig } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
    if (!pool) {
        const config: PoolConfig = {
            connectionString: process.env.DATABASE_URL,
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

import pg from "pg";

// Return DATE columns as 'YYYY-MM-DD' strings (no timezone shifting) and bigint as number.
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured");
    const local = /@(localhost|127\.0\.0\.1)|host=\/tmp/.test(url) || url.includes("/tmp");
    pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX ?? 3),
      idleTimeoutMillis: 10_000,
      ssl: local || process.env.DATABASE_SSL === "false" ? undefined : { rejectUnauthorized: true },
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

export type Db = pg.PoolClient | pg.Pool;

export async function query<T = any>(text: string, params: unknown[] = [], db: Db = getPool()): Promise<T[]> {
  const r = await db.query(text, params as any[]);
  return r.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = [], db: Db = getPool()): Promise<T | null> {
  const rows = await query<T>(text, params, db);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

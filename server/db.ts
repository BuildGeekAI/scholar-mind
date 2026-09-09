import pg from 'pg';

/**
 * The Postgres pool, constructed lazily so that merely importing the router — as
 * `vite.config.ts` does at config-load time — never opens a connection or
 * demands credentials.
 *
 * `server/env.ts` must already have run; see its header for why that ordering is
 * load-bearing.
 */
let _pool: pg.Pool | undefined;

/** Cloud Run runs many instances, each with its own pool, against one Cloud SQL
 * instance's connection ceiling. Small per-pool, sized up by env when needed. */
const MAX_CLIENTS = Number(process.env.PGPOOL_MAX || 5);

export const connectionString = (): string =>
  process.env.DATABASE_URL ||
  'postgres://scholarmind:scholarmind@127.0.0.1:5432/scholarmind';

export const pool = (): pg.Pool => {
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString: connectionString(),
      max: MAX_CLIENTS,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // A pool that emits an unhandled 'error' takes the process down; a dropped
    // idle connection is routine and must not.
    _pool.on('error', e => console.error('Postgres pool error:', e.message));
  }
  return _pool;
};

export type Queryable = Pick<pg.PoolClient, 'query'>;

export const query = async <T extends pg.QueryResultRow = any>(
  text: string,
  values: unknown[] = []
): Promise<pg.QueryResult<T>> => pool().query<T>(text, values);

/** One row or null — the shape most callers actually want. */
export const one = async <T extends pg.QueryResultRow = any>(
  text: string,
  values: unknown[] = []
): Promise<T | null> => (await query<T>(text, values)).rows[0] ?? null;

export const many = async <T extends pg.QueryResultRow = any>(
  text: string,
  values: unknown[] = []
): Promise<T[]> => (await query<T>(text, values)).rows;

/**
 * Runs `fn` inside a transaction. This is what makes "write the row and enqueue
 * the job that processes it" a single atomic act — the property the whole queue
 * design rests on.
 */
export const transaction = async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
};

export const closePool = async (): Promise<void> => {
  if (_pool) {
    const p = _pool;
    _pool = undefined;
    await p.end();
  }
};

/** Used by /api/healthz: reports reachability without throwing. */
export const ping = async (): Promise<boolean> => {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
};

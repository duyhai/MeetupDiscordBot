import pg from 'pg';
import { Logger } from 'tslog';

const logger = new Logger({ name: 'dashboardPool' });

/**
 * Dashboard tables. Idempotent, so it runs on every boot. DATE columns are
 * always written as `$n::date` from a 'YYYY-MM-DD' string and read back with
 * to_char: node-pg parses DATE at local midnight, which shifts the day in a
 * non-UTC process.
 */
export const DASHBOARD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS report_snapshots (
  id              SERIAL PRIMARY KEY,
  report_type     TEXT NOT NULL CHECK (report_type IN ('hall_of_fame', 'no_show')),
  period          DATE NOT NULL CHECK (EXTRACT(DAY FROM period) = 1),
  built_at        TIMESTAMPTZ NOT NULL,
  built_by        TEXT NOT NULL CHECK (built_by IN ('job', 'backfill') OR built_by ~ '^[0-9]{1,20}$'),
  source_complete BOOLEAN NOT NULL,
  payload         JSONB NOT NULL,
  superseded_by   INTEGER REFERENCES report_snapshots(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS report_snapshots_current_idx
  ON report_snapshots (report_type, period) WHERE superseded_by IS NULL;
CREATE TABLE IF NOT EXISTS link_progress_daily (
  day             DATE PRIMARY KEY,
  linked          INTEGER NOT NULL,
  unlinked        INTEGER NOT NULL,
  reverify_tagged INTEGER NOT NULL,
  onboarding      INTEGER NOT NULL
);
-- Durable "report ready already posted" marker: a restart cannot post the
-- notice twice, and a failed post is deleted so the next tick retries.
CREATE TABLE IF NOT EXISTS dashboard_notices (
  kind      TEXT NOT NULL CHECK (kind IN ('report_ready')),
  period    DATE NOT NULL CHECK (EXTRACT(DAY FROM period) = 1),
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, period)
);
`;

/** pg_advisory_xact_lock(int, int) namespace for dashboard locks. */
export const DASHBOARD_LOCK_CLASS = 52061;
/** (DASHBOARD_LOCK_CLASS, SCHEMA_LOCK_KEY) serializes schema creation. */
export const SCHEMA_LOCK_KEY = 0;

const DEFAULT_POOL_SIZE = 3;

/**
 * PG_POOL_MAX if it is an integer 1..10, else 3. Three keeps the web dyno
 * within its share of essential-0's 20 connections.
 */
export function dashboardPoolSize(
  env: Record<string, string | undefined> = process.env,
): number {
  const requested = Number(env.PG_POOL_MAX);
  return Number.isInteger(requested) && requested >= 1 && requested <= 10
    ? requested
    : DEFAULT_POOL_SIZE;
}

/**
 * Serialized by an advisory lock: concurrent CREATE TABLE IF NOT EXISTS
 * from two sessions can still fail on pg_type's unique index (web dyno and a
 * backfill dyno booting together, or parallel integration files).
 */
export async function ensureDashboardSchema(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      DASHBOARD_LOCK_CLASS,
      SCHEMA_LOCK_KEY,
    ]);
    await client.query(DASHBOARD_SCHEMA_SQL);
    const commit = await client.query('COMMIT');
    // A caught error inside the transaction makes COMMIT answer ROLLBACK.
    if (commit.command === 'ROLLBACK') {
      throw new Error('dashboard schema transaction rolled back');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

let sharedPool: pg.Pool | undefined;
let schemaEnsured: Promise<void> | undefined;

function createPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('dashboardPool requires DATABASE_URL to be set');
  }
  const isLocal =
    connectionString.includes('localhost') ||
    connectionString.includes('127.0.0.1');
  const pool = new pg.Pool({
    connectionString,
    max: dashboardPoolSize(),
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    allowExitOnIdle: true,
  });
  pool.on('error', (error) => {
    logger.error(`Postgres pool error: ${String(error)}`);
  });
  return pool;
}

/** The shared dashboard pool; its schema is ensured once (retried after a failure). */
export async function dashboardPool(): Promise<pg.Pool> {
  if (sharedPool === undefined) {
    sharedPool = createPool();
  }
  const pool = sharedPool;
  if (schemaEnsured === undefined) {
    schemaEnsured = ensureDashboardSchema(pool);
  }
  try {
    await schemaEnsured;
  } catch (error) {
    schemaEnsured = undefined; // retry on next call
    throw error;
  }
  return pool;
}

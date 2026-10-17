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
-- One report-ready notice per month. claimed_at is when a process took it
-- (the database clock); posted_at is set only once the post landed. An
-- unposted claim older than NOTICE_RECLAIM_AFTER_MS is a crash and is taken
-- again; a failed post moves claimed_at to -infinity so the next tick retries.
CREATE TABLE IF NOT EXISTS dashboard_notices (
  kind       TEXT NOT NULL CHECK (kind IN ('report_ready')),
  period     DATE NOT NULL CHECK (EXTRACT(DAY FROM period) = 1),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at  TIMESTAMPTZ,
  PRIMARY KEY (kind, period)
);
-- PR 2 tables: posted_at NOT NULL DEFAULT now() held the claim time and
-- there was no claimed_at. Rows from then count as posted. Guarded by a
-- catalog read, so a boot on a table that has claimed_at (upgraded, or
-- created above) only reads: ALTER TABLE, even ADD COLUMN IF NOT EXISTS,
-- would take an ACCESS EXCLUSIVE lock on every boot.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'dashboard_notices'
       AND column_name = 'claimed_at'
  ) THEN
    ALTER TABLE dashboard_notices ADD COLUMN claimed_at TIMESTAMPTZ;
    UPDATE dashboard_notices SET claimed_at = posted_at;
    ALTER TABLE dashboard_notices
      ALTER COLUMN claimed_at SET DEFAULT now(),
      ALTER COLUMN claimed_at SET NOT NULL,
      ALTER COLUMN posted_at DROP DEFAULT,
      ALTER COLUMN posted_at DROP NOT NULL;
  END IF;
END
$$;
-- Per-member no-show lookups: payload @> '{"cases":[{"member":{"id":"…"}}]}'
-- (and the cleared/departed forms). Partial: only current no-show rows are
-- searched, and queries must state this predicate literally to use it.
CREATE INDEX IF NOT EXISTS report_snapshots_noshow_payload_idx
  ON report_snapshots USING GIN (payload jsonb_path_ops)
  WHERE report_type = 'no_show' AND superseded_by IS NULL;
`;

/** pg_advisory_xact_lock(int, int) namespace for dashboard locks. */
export const DASHBOARD_LOCK_CLASS = 52061;
/**
 * pg_advisory_xact_lock(int, int) namespace for per-member locks
 * (MEMBER_LOCK_CLASS, hashtext('suspension:' || member id)), kept apart from
 * DASHBOARD_LOCK_CLASS so a member key can never equal a month, report or
 * schema key.
 */
export const MEMBER_LOCK_CLASS = 52062;
/** (DASHBOARD_LOCK_CLASS, SCHEMA_LOCK_KEY) serializes schema creation. */
export const SCHEMA_LOCK_KEY = 0;

const DEFAULT_POOL_SIZE = 3;

/**
 * How long a dashboard transaction waits for an advisory lock. Holders are
 * other snapshot saves or schema creation: a few statements, well under a
 * second, so a 15 s wait means the holder is stuck and the save should fail
 * (the next tick retries) rather than queue forever.
 */
export const DASHBOARD_LOCK_TIMEOUT_MS = 15_000;
/**
 * Postgres ends a session that sits idle inside one of these transactions
 * this long, releasing its locks even if the process holding them is wedged.
 * The transactions never wait on anything but the database between
 * statements.
 */
export const DASHBOARD_IDLE_IN_TRANSACTION_TIMEOUT_MS = 20_000;
/** Pool-wide backstop for any single statement. */
export const DASHBOARD_STATEMENT_TIMEOUT_MS = 30_000;
/** Backstop for pool.connect(), as in the credential repository. */
export const DASHBOARD_CONNECTION_TIMEOUT_MS = 40_000;

export interface DashboardTransactionOptions {
  /** Overrides DASHBOARD_LOCK_TIMEOUT_MS (tests use a short one). */
  lockTimeoutMs?: number;
}

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
 * Runs `fn` inside one transaction on a checked-out client, with
 * transaction-local lock and idle timeouts. The pattern of
 * PostgresCredentialRepository.inLockedTransaction:
 * - pg-pool drops its idle 'error' listener while a client is checked out,
 *   so a backend dying mid-transaction (terminated, idle timeout, network)
 *   would emit an unhandled 'error' and crash the process. A listener is
 *   attached for the whole checkout.
 * - A client whose connection died, or whose ROLLBACK failed, is destroyed
 *   (release(true)) instead of being handed back to the pool.
 * - A statement error caught inside the transaction makes COMMIT answer
 *   ROLLBACK without raising; that is reported as the failure it is.
 */
export async function inDashboardTransaction<T>(
  pool: pg.Pool,
  label: string,
  fn: (client: pg.PoolClient) => Promise<T>,
  options: DashboardTransactionOptions = {},
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  const onError = (error: Error): void => {
    logger.error(`Postgres connection lost during ${label}: ${error.name}`);
    broken = true;
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('lock_timeout', $1, true),
              set_config('idle_in_transaction_session_timeout', $2, true)`,
      [
        `${options.lockTimeoutMs ?? DASHBOARD_LOCK_TIMEOUT_MS}ms`,
        `${DASHBOARD_IDLE_IN_TRANSACTION_TIMEOUT_MS}ms`,
      ],
    );
    const result = await fn(client);
    const commit = await client.query('COMMIT');
    if (commit.command === 'ROLLBACK') {
      throw new Error(`${label} rolled back`);
    }
    return result;
  } catch (error) {
    if (!broken) {
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
    }
    throw error;
  } finally {
    client.removeListener('error', onError);
    client.release(broken);
  }
}

/**
 * Serialized by an advisory lock: concurrent CREATE TABLE IF NOT EXISTS
 * from two sessions can still fail on pg_type's unique index (web dyno and a
 * backfill dyno booting together, or parallel integration files).
 */
export async function ensureDashboardSchema(
  pool: pg.Pool,
  options: DashboardTransactionOptions = {},
): Promise<void> {
  await inDashboardTransaction(
    pool,
    'dashboard schema transaction',
    async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        DASHBOARD_LOCK_CLASS,
        SCHEMA_LOCK_KEY,
      ]);
      await client.query(DASHBOARD_SCHEMA_SQL);
    },
    options,
  );
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
    connectionTimeoutMillis: DASHBOARD_CONNECTION_TIMEOUT_MS,
    statement_timeout: DASHBOARD_STATEMENT_TIMEOUT_MS,
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
  const pending = schemaEnsured;
  try {
    await pending;
  } catch (error) {
    // Only the failed attempt is cleared: a retry another caller already
    // started is left alone.
    if (schemaEnsured === pending) {
      schemaEnsured = undefined;
    }
    throw error;
  }
  return pool;
}

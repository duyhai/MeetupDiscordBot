import pg from 'pg';

import {
  DASHBOARD_LOCK_CLASS,
  dashboardPool,
  DashboardTransactionOptions,
  inDashboardTransaction,
  SCHEMA_LOCK_KEY,
} from './dashboardPool.js';

const MEETUP_ID = /^[1-9][0-9]{0,19}$/;
const DISCORD_ID_SQL = `'^[0-9]{17,20}$'`;
const MEETUP_ID_SQL = `'^[1-9][0-9]{0,19}$'`;

/** A promote/demote reason is free text a leader types; capped like workspace notes. */
export const PROMOTION_REASON_MAX = 2000;

/**
 * Idempotent; runs under the dashboard schema lock. `promoted_hosts` is the
 * source of truth for a host's tier (one row per member, current state);
 * `promoted_host_events` is the append-only history of every promote and
 * demote, never edited. The host dashboard reads the first; promote/demote
 * (PR 3) writes both in one transaction.
 */
export const PROMOTED_HOST_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS promoted_hosts (
  meetup_member_id TEXT PRIMARY KEY CHECK (meetup_member_id ~ ${MEETUP_ID_SQL}),
  active           BOOLEAN NOT NULL,
  reason           TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND ${PROMOTION_REASON_MAX}),
  changed_by       TEXT NOT NULL CHECK (changed_by ~ ${DISCORD_ID_SQL}),
  changed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  version          INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
);
CREATE TABLE IF NOT EXISTS promoted_host_events (
  id               BIGSERIAL PRIMARY KEY,
  meetup_member_id TEXT NOT NULL CHECK (meetup_member_id ~ ${MEETUP_ID_SQL}),
  action           TEXT NOT NULL CHECK (action IN ('promote', 'demote')),
  reason           TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND ${PROMOTION_REASON_MAX}),
  actor_discord_id TEXT NOT NULL CHECK (actor_discord_id ~ ${DISCORD_ID_SQL}),
  -- The promoted_hosts.version this change produced, so a race between two
  -- leaders can be read back from the history.
  version          INTEGER NOT NULL CHECK (version >= 1),
  at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The history is append-only: UPDATE and DELETE are refused (TRUNCATE,
-- test-only, is not a row event).
CREATE OR REPLACE FUNCTION promoted_host_events_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'promoted_host_events is append-only'; END $fn$;
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE t.tgname = 'promoted_host_events_append_only'
       AND c.relname = 'promoted_host_events'
       AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
  ) THEN
    CREATE TRIGGER promoted_host_events_append_only
      BEFORE UPDATE OR DELETE ON promoted_host_events
      FOR EACH ROW EXECUTE FUNCTION promoted_host_events_append_only();
  END IF;
END
$do$;
`;

/** PROMOTED_HOST_SCHEMA_SQL in one transaction under the dashboard schema lock. */
export async function ensurePromotedHostSchema(
  pool: pg.Pool,
  options: DashboardTransactionOptions = {},
): Promise<void> {
  await inDashboardTransaction(
    pool,
    'promoted host schema transaction',
    async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        DASHBOARD_LOCK_CLASS,
        SCHEMA_LOCK_KEY,
      ]);
      await client.query(PROMOTED_HOST_SCHEMA_SQL);
    },
    options,
  );
}

/** promoted_hosts on the dashboard pool. Read side only until promotion ships. */
export class PostgresPromotedHostRepository {
  private static singleton: Promise<PostgresPromotedHostRepository> | undefined;

  constructor(private readonly pool: pg.Pool) {}

  static instance(): Promise<PostgresPromotedHostRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(async (pool) => {
        await ensurePromotedHostSchema(pool);
        return new PostgresPromotedHostRepository(pool);
      });
      this.singleton = pending;
      // A failed schema ensure is retried on the next call.
      pending.catch(() => {
        if (this.singleton === pending) {
          this.singleton = undefined;
        }
      });
    }
    return this.singleton;
  }

  /** True only for an active row; an id that cannot be a Meetup id is never promoted. */
  async isPromoted(meetupMemberId: string): Promise<boolean> {
    if (typeof meetupMemberId !== 'string' || !MEETUP_ID.test(meetupMemberId)) {
      return false;
    }
    const { rows } = await this.pool.query<{ active: boolean }>(
      'SELECT active FROM promoted_hosts WHERE meetup_member_id = $1',
      [meetupMemberId],
    );
    return rows[0]?.active === true;
  }
}

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
 * demote, never edited. The host dashboard reads the first; promote and
 * demote (the staff dashboard) write both in one transaction.
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

/** A member's current row. */
export interface PromotedHost {
  meetupMemberId: string;
  active: boolean;
  reason: string;
  changedBy: string;
  changedAt: Date;
  version: number;
}

/** One promote or demote, as the history keeps it. */
export interface PromotionEvent {
  meetupMemberId: string;
  action: 'promote' | 'demote';
  reason: string;
  actorDiscordId: string;
  version: number;
  at: Date;
}

/**
 * How a promote or demote ended. `stale`: the row is not at the version the
 * leader saw (someone else changed it first); `unchanged`: it is already
 * what was asked (promoting an active host, demoting an inactive one);
 * `never-promoted`: a demote of someone with no row.
 */
export type PromotionChange =
  | { code: 'changed'; row: PromotedHost }
  | { code: 'stale' | 'unchanged' | 'never-promoted' };

interface PromotedRow {
  meetup_member_id: string;
  active: boolean;
  reason: string;
  changed_by: string;
  changed_at: Date;
  version: number;
}

const toPromotedHost = (r: PromotedRow): PromotedHost => ({
  meetupMemberId: r.meetup_member_id,
  active: r.active,
  reason: r.reason,
  changedBy: r.changed_by,
  changedAt: r.changed_at,
  version: r.version,
});

/** promoted_hosts and its history on the dashboard pool. */
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

  /** Every row, active first, then most recently changed. */
  async list(): Promise<PromotedHost[]> {
    const { rows } = await this.pool.query<PromotedRow>(
      `SELECT meetup_member_id, active, reason, changed_by, changed_at, version
         FROM promoted_hosts ORDER BY active DESC, changed_at DESC`,
    );
    return rows.map(toPromotedHost);
  }

  /** One member's row, if any. */
  async get(meetupMemberId: string): Promise<PromotedHost | undefined> {
    if (!MEETUP_ID.test(meetupMemberId)) {
      return undefined;
    }
    const { rows } = await this.pool.query<PromotedRow>(
      `SELECT meetup_member_id, active, reason, changed_by, changed_at, version
         FROM promoted_hosts WHERE meetup_member_id = $1`,
      [meetupMemberId],
    );
    return rows[0] ? toPromotedHost(rows[0]) : undefined;
  }

  /** One member's promotes and demotes, newest first. */
  async history(meetupMemberId: string, limit = 50): Promise<PromotionEvent[]> {
    if (!MEETUP_ID.test(meetupMemberId)) {
      return [];
    }
    const { rows } = await this.pool.query<{
      meetup_member_id: string;
      action: 'promote' | 'demote';
      reason: string;
      actor_discord_id: string;
      version: number;
      at: Date;
    }>(
      `SELECT meetup_member_id, action, reason, actor_discord_id, version, at
         FROM promoted_host_events WHERE meetup_member_id = $1
        ORDER BY id DESC LIMIT $2`,
      [meetupMemberId, limit],
    );
    return rows.map((r) => ({
      meetupMemberId: r.meetup_member_id,
      action: r.action,
      reason: r.reason,
      actorDiscordId: r.actor_discord_id,
      version: r.version,
      at: r.at,
    }));
  }

  /**
   * Promote or demote, as a compare-and-set on the version the leader saw
   * (`seenVersion` 0: they saw no row). The first promote inserts (ON
   * CONFLICT DO NOTHING: a concurrent first promote wins and this one is
   * stale); later changes bump the version. The history row, with the
   * version the change produced, is written in the same transaction.
   */
  async change(
    action: 'promote' | 'demote',
    meetupMemberId: string,
    seenVersion: number,
    actorDiscordId: string,
    reason: string,
  ): Promise<PromotionChange> {
    if (!MEETUP_ID.test(meetupMemberId)) {
      throw new RangeError('not a Meetup member id');
    }
    const active = action === 'promote';
    return inDashboardTransaction(
      this.pool,
      'promoted host change',
      async (client) => {
        const current = (
          await client.query<PromotedRow>(
            `SELECT meetup_member_id, active, reason, changed_by, changed_at, version
               FROM promoted_hosts WHERE meetup_member_id = $1 FOR UPDATE`,
            [meetupMemberId],
          )
        ).rows[0];
        if (current === undefined && !active) {
          return { code: 'never-promoted' } as const;
        }
        if ((current?.version ?? 0) !== seenVersion) {
          return { code: 'stale' } as const;
        }
        if (current !== undefined && current.active === active) {
          return { code: 'unchanged' } as const;
        }
        const written = (
          current === undefined
            ? await client.query<PromotedRow>(
                `INSERT INTO promoted_hosts (meetup_member_id, active, reason, changed_by)
                 VALUES ($1, true, $2, $3)
                 ON CONFLICT (meetup_member_id) DO NOTHING
                 RETURNING meetup_member_id, active, reason, changed_by, changed_at, version`,
                [meetupMemberId, reason, actorDiscordId],
              )
            : await client.query<PromotedRow>(
                `UPDATE promoted_hosts
                    SET active = $2, reason = $3, changed_by = $4,
                        changed_at = now(), version = version + 1
                  WHERE meetup_member_id = $1 AND version = $5
                 RETURNING meetup_member_id, active, reason, changed_by, changed_at, version`,
                [meetupMemberId, active, reason, actorDiscordId, seenVersion],
              )
        ).rows[0];
        if (written === undefined) {
          return { code: 'stale' } as const;
        }
        await client.query(
          `INSERT INTO promoted_host_events
             (meetup_member_id, action, reason, actor_discord_id, version)
           VALUES ($1, $2, $3, $4, $5)`,
          [meetupMemberId, action, reason, actorDiscordId, written.version],
        );
        return { code: 'changed', row: toPromotedHost(written) } as const;
      },
    );
  }
}

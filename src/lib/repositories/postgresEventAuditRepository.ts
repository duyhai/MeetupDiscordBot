import pg from 'pg';

import {
  EventChange,
  EventChangeKind,
  EventHost,
  EventObservation,
  EventSnapshot,
  NewEventChange,
  isEventChangeKind,
} from '../eventAudit/types.js';
import {
  DASHBOARD_LOCK_CLASS,
  dashboardPool,
  DashboardTransactionOptions,
  inDashboardTransaction,
  SCHEMA_LOCK_KEY,
} from './dashboardPool.js';

const EVENT_ID = /^[0-9]{1,20}$/;
const DISCORD_ID = /^[0-9]{17,20}$/;
/** Snapshots and changes older than this are pruned at the end of a run. */
export const EVENT_AUDIT_RETENTION_DAYS = 180;
const DEFAULT_PAGE = 50;

/**
 * Idempotent; runs under the dashboard schema lock. One row per run
 * (event_audit_runs), one snapshot per event per run (event_snapshots), one
 * state row per event ever seen with its latest snapshot (event_audit_state)
 * and one row per detected change (event_changes). Snapshots and changes are
 * append-only: a trigger refuses UPDATE (except event_changes.alerted_at)
 * and any DELETE of a row younger than the retention period, so a bug
 * cannot edit the audit.
 */
export const EVENT_AUDIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS event_audit_runs (
  id            BIGSERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  requested_by  TEXT NOT NULL CHECK (requested_by = 'job' OR requested_by ~ '^[0-9]{17,20}$'),
  listed        INTEGER,
  confirmed     INTEGER,
  changes       INTEGER,
  outcome       TEXT CHECK (outcome IN ('saved', 'failed'))
);
CREATE INDEX IF NOT EXISTS event_audit_runs_started_idx ON event_audit_runs (started_at DESC);
CREATE TABLE IF NOT EXISTS event_snapshots (
  id               BIGSERIAL PRIMARY KEY,
  run_id           BIGINT NOT NULL REFERENCES event_audit_runs(id),
  meetup_event_id  TEXT NOT NULL CHECK (meetup_event_id ~ '^[0-9]{1,20}$'),
  taken_at         TIMESTAMPTZ NOT NULL,
  title            TEXT NOT NULL CHECK (length(title) <= 300),
  status           TEXT NOT NULL CHECK (length(status) <= 32),
  start_at         TIMESTAMPTZ NOT NULL,
  duration         TEXT CHECK (duration IS NULL OR duration ~ '^P[0-9A-Z.]{1,30}$'),
  event_url        TEXT CHECK (event_url IS NULL OR length(event_url) <= 200),
  venue_id         TEXT CHECK (venue_id IS NULL OR venue_id ~ '^[0-9]{1,20}$'),
  photo_id         TEXT CHECK (photo_id IS NULL OR photo_id ~ '^[0-9]{1,20}$'),
  hosts            JSONB NOT NULL,
  rsvp_yes         INTEGER CHECK (rsvp_yes IS NULL OR rsvp_yes >= 0),
  waitlist         INTEGER CHECK (waitlist IS NULL OR waitlist >= 0),
  rsvps_closed     BOOLEAN,
  last_edited_at   TIMESTAMPTZ,
  UNIQUE (meetup_event_id, run_id)
);
CREATE INDEX IF NOT EXISTS event_snapshots_event_taken_idx
  ON event_snapshots (meetup_event_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS event_snapshots_taken_idx ON event_snapshots (taken_at);
CREATE TABLE IF NOT EXISTS event_audit_state (
  meetup_event_id     TEXT PRIMARY KEY CHECK (meetup_event_id ~ '^[0-9]{1,20}$'),
  latest_snapshot_id  BIGINT NOT NULL REFERENCES event_snapshots(id),
  first_seen_at       TIMESTAMPTZ NOT NULL,
  last_seen_at        TIMESTAMPTZ NOT NULL,
  deleted_at          TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS event_changes (
  id               BIGSERIAL PRIMARY KEY,
  run_id           BIGINT NOT NULL REFERENCES event_audit_runs(id),
  meetup_event_id  TEXT NOT NULL CHECK (meetup_event_id ~ '^[0-9]{1,20}$'),
  detected_at      TIMESTAMPTZ NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('created','cancelled','deleted','host_changed',
                                                 'start_moved','title_changed','rsvp_drop','rsvps_closed')),
  old_value        JSONB,
  new_value        JSONB,
  title            TEXT NOT NULL CHECK (length(title) <= 300),
  start_at         TIMESTAMPTZ NOT NULL,
  event_url        TEXT CHECK (event_url IS NULL OR length(event_url) <= 200),
  -- Hosts at the time, the likely actors: for host_changed the union of old and new.
  hosts            JSONB NOT NULL,
  rsvp_yes         INTEGER CHECK (rsvp_yes IS NULL OR rsvp_yes >= 0),
  waitlist         INTEGER CHECK (waitlist IS NULL OR waitlist >= 0),
  actor            TEXT CHECK (actor IS NULL OR actor ~ '^[0-9]{1,20}$'),
  alerted_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS event_changes_detected_idx ON event_changes (detected_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS event_changes_event_idx ON event_changes (meetup_event_id, id DESC);
CREATE INDEX IF NOT EXISTS event_changes_hosts_idx ON event_changes USING GIN (hosts jsonb_path_ops);
-- Append-only (TRUNCATE, test-only, is not a row event). A change may only
-- have alerted_at set; a snapshot never changes; both may be deleted only
-- once older than the retention period (the prune).
CREATE OR REPLACE FUNCTION event_changes_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF to_jsonb(OLD) - 'alerted_at' <> to_jsonb(NEW) - 'alerted_at' THEN
      RAISE EXCEPTION 'event_changes is append-only (only alerted_at may change)';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.detected_at >= now() - make_interval(days => ${EVENT_AUDIT_RETENTION_DAYS}) THEN
    RAISE EXCEPTION 'event_changes is append-only (rows within retention cannot be deleted)';
  END IF;
  RETURN OLD;
END $fn$;
CREATE OR REPLACE FUNCTION event_snapshots_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'event_snapshots is append-only';
  END IF;
  IF OLD.taken_at >= now() - make_interval(days => ${EVENT_AUDIT_RETENTION_DAYS}) THEN
    RAISE EXCEPTION 'event_snapshots is append-only (rows within retention cannot be deleted)';
  END IF;
  RETURN OLD;
END $fn$;
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE t.tgname = 'event_changes_append_only' AND c.relname = 'event_changes'
       AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
  ) THEN
    CREATE TRIGGER event_changes_append_only
      BEFORE UPDATE OR DELETE ON event_changes
      FOR EACH ROW EXECUTE FUNCTION event_changes_append_only();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE t.tgname = 'event_snapshots_append_only' AND c.relname = 'event_snapshots'
       AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
  ) THEN
    CREATE TRIGGER event_snapshots_append_only
      BEFORE UPDATE OR DELETE ON event_snapshots
      FOR EACH ROW EXECUTE FUNCTION event_snapshots_append_only();
  END IF;
END
$do$;
`;

export async function ensureEventAuditSchema(
  pool: pg.Pool,
  options: DashboardTransactionOptions = {},
): Promise<void> {
  await inDashboardTransaction(
    pool,
    'event audit schema transaction',
    async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        DASHBOARD_LOCK_CLASS,
        SCHEMA_LOCK_KEY,
      ]);
      await client.query(EVENT_AUDIT_SCHEMA_SQL);
    },
    options,
  );
}

export interface EventAuditRun {
  id: number;
  startedAt: Date;
  finishedAt: Date | null;
  requestedBy: string;
  listed: number | null;
  confirmed: number | null;
  changes: number | null;
  outcome: 'saved' | 'failed' | null;
}

/** One event ever seen: its latest snapshot and whether it is gone. */
export interface EventState {
  eventId: string;
  latest: EventSnapshot;
  firstSeenAt: Date;
  lastSeenAt: Date;
  deletedAt: Date | null;
}

/** Everything one saved run writes, in one transaction. Snapshots are taken at startedAt; changes detected at finishedAt. */
export interface RunWrite {
  startedAt: Date;
  finishedAt: Date;
  requestedBy: string;
  listed: number;
  confirmed: number;
  observations: EventObservation[];
  deletedEventIds: string[];
  changes: NewEventChange[];
}

export interface ChangeFilter {
  kind?: EventChangeKind;
  hostId?: string;
  from?: Date;
  to?: Date;
  /** Only changes with a smaller id (the page cursor). */
  beforeId?: number;
}

export interface EventHistory {
  state: EventState;
  changes: EventChange[];
  snapshots: EventSnapshot[];
}

interface RunRow {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  requested_by: string;
  listed: number | null;
  confirmed: number | null;
  changes: number | null;
  outcome: 'saved' | 'failed' | null;
}

interface SnapshotRow {
  id: string;
  run_id: string;
  meetup_event_id: string;
  taken_at: Date;
  title: string;
  status: string;
  start_at: Date;
  duration: string | null;
  event_url: string | null;
  venue_id: string | null;
  photo_id: string | null;
  hosts: unknown;
  rsvp_yes: number | null;
  waitlist: number | null;
  rsvps_closed: boolean | null;
  last_edited_at: Date | null;
}

interface StateRow extends SnapshotRow {
  first_seen_at: Date;
  last_seen_at: Date;
  deleted_at: Date | null;
}

interface ChangeRow {
  id: string;
  run_id: string;
  meetup_event_id: string;
  detected_at: Date;
  kind: string;
  old_value: unknown;
  new_value: unknown;
  title: string;
  start_at: Date;
  event_url: string | null;
  hosts: unknown;
  rsvp_yes: number | null;
  waitlist: number | null;
  actor: string | null;
  alerted_at: Date | null;
}

/** Only a list of { id: digits, name: string } is trusted; anything else reads as no hosts. */
export function parseHosts(value: unknown): EventHost[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const hosts: EventHost[] = [];
  for (const entry of value as unknown[]) {
    const h = entry as { id?: unknown; name?: unknown } | null;
    if (
      typeof h === 'object' &&
      h !== null &&
      typeof h.id === 'string' &&
      EVENT_ID.test(h.id) &&
      typeof h.name === 'string'
    ) {
      hosts.push({ id: h.id, name: h.name });
    } else {
      return [];
    }
  }
  return hosts;
}

const toRun = (r: RunRow): EventAuditRun => ({
  id: Number(r.id),
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  requestedBy: r.requested_by,
  listed: r.listed,
  confirmed: r.confirmed,
  changes: r.changes,
  outcome: r.outcome,
});

const toSnapshot = (r: SnapshotRow): EventSnapshot => ({
  id: Number(r.id),
  runId: Number(r.run_id),
  eventId: r.meetup_event_id,
  takenAt: r.taken_at,
  title: r.title,
  status: r.status,
  startAt: r.start_at,
  duration: r.duration,
  eventUrl: r.event_url,
  venueId: r.venue_id,
  photoId: r.photo_id,
  hosts: parseHosts(r.hosts),
  rsvpYes: r.rsvp_yes,
  waitlist: r.waitlist,
  rsvpsClosed: r.rsvps_closed,
  lastEditedAt: r.last_edited_at,
});

const toState = (r: StateRow): EventState => ({
  eventId: r.meetup_event_id,
  latest: toSnapshot(r),
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  deletedAt: r.deleted_at,
});

const toChange = (r: ChangeRow): EventChange => ({
  id: Number(r.id),
  runId: Number(r.run_id),
  eventId: r.meetup_event_id,
  detectedAt: r.detected_at,
  // The CHECK constraint keeps it one of the kinds; the fallback is belt and braces.
  kind: isEventChangeKind(r.kind) ? r.kind : 'created',
  oldValue: r.old_value,
  newValue: r.new_value,
  title: r.title,
  startAt: r.start_at,
  eventUrl: r.event_url,
  hosts: parseHosts(r.hosts),
  rsvpYes: r.rsvp_yes,
  waitlist: r.waitlist,
  actor: r.actor,
  alertedAt: r.alerted_at,
});

const SNAPSHOT_COLUMNS = `s.id, s.run_id, s.meetup_event_id, s.taken_at, s.title, s.status, s.start_at,
  s.duration, s.event_url, s.venue_id, s.photo_id, s.hosts, s.rsvp_yes, s.waitlist, s.rsvps_closed, s.last_edited_at`;
const STATE_SELECT = `SELECT ${SNAPSHOT_COLUMNS}, st.first_seen_at, st.last_seen_at, st.deleted_at
  FROM event_audit_state st JOIN event_snapshots s ON s.id = st.latest_snapshot_id`;

const json = (value: unknown) => JSON.stringify(value ?? null);

/** The event audit tables on the dashboard pool. */
export class PostgresEventAuditRepository {
  private static singleton: Promise<PostgresEventAuditRepository> | undefined;

  constructor(private readonly pool: pg.Pool) {}

  static instance(): Promise<PostgresEventAuditRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(async (pool) => {
        await ensureEventAuditSchema(pool);
        return new PostgresEventAuditRepository(pool);
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

  /** The newest run by start time, saved or failed. */
  async latestRun(): Promise<EventAuditRun | undefined> {
    const { rows } = await this.pool.query<RunRow>(
      'SELECT * FROM event_audit_runs ORDER BY started_at DESC, id DESC LIMIT 1',
    );
    return rows[0] ? toRun(rows[0]) : undefined;
  }

  /** The newest saved run: what the hourly due rule is measured from. */
  async latestSavedRun(): Promise<EventAuditRun | undefined> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT * FROM event_audit_runs WHERE outcome = 'saved'
        ORDER BY started_at DESC, id DESC LIMIT 1`,
    );
    return rows[0] ? toRun(rows[0]) : undefined;
  }

  /** False only before the first saved run: the baseline. */
  async hasAnyState(): Promise<boolean> {
    const { rows } = await this.pool.query<{ one: number }>(
      'SELECT 1 AS one FROM event_audit_state LIMIT 1',
    );
    return rows.length > 0;
  }

  /** Every event not recorded as deleted, with its latest snapshot. */
  async liveStates(): Promise<EventState[]> {
    const { rows } = await this.pool.query<StateRow>(
      `${STATE_SELECT} WHERE st.deleted_at IS NULL ORDER BY st.meetup_event_id`,
    );
    return rows.map(toState);
  }

  /**
   * One saved run, in one transaction: the run row, a snapshot per
   * observation, the state upserts (first_seen kept), deleted_at on the
   * confirmed deletions, and the change rows. Nothing is written on a
   * failure.
   */
  async saveRun(
    write: RunWrite,
  ): Promise<{ runId: number; changes: EventChange[] }> {
    if (write.requestedBy !== 'job' && !DISCORD_ID.test(write.requestedBy)) {
      throw new RangeError('requestedBy must be job or a Discord id');
    }
    return inDashboardTransaction(
      this.pool,
      'event audit run',
      async (client) => {
        const run = await client.query<{ id: string }>(
          `INSERT INTO event_audit_runs
           (started_at, finished_at, requested_by, listed, confirmed, changes, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, 'saved') RETURNING id`,
          [
            write.startedAt,
            write.finishedAt,
            write.requestedBy,
            write.listed,
            write.confirmed,
            write.changes.length,
          ],
        );
        const runId = Number(run.rows[0].id);
        for (const o of write.observations) {
          // eslint-disable-next-line no-await-in-loop -- one transaction, a few dozen rows
          const snapshot = await client.query<{ id: string }>(
            `INSERT INTO event_snapshots
             (run_id, meetup_event_id, taken_at, title, status, start_at, duration, event_url,
              venue_id, photo_id, hosts, rsvp_yes, waitlist, rsvps_closed, last_edited_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15)
           RETURNING id`,
            [
              runId,
              o.eventId,
              write.startedAt,
              o.title,
              o.status,
              o.startAt,
              o.duration,
              o.eventUrl,
              o.venueId,
              o.photoId,
              json(o.hosts),
              o.rsvpYes,
              o.waitlist,
              o.rsvpsClosed,
              o.lastEditedAt,
            ],
          );
          // eslint-disable-next-line no-await-in-loop -- one transaction, a few dozen rows
          await client.query(
            `INSERT INTO event_audit_state
             (meetup_event_id, latest_snapshot_id, first_seen_at, last_seen_at, deleted_at)
           VALUES ($1, $2, $3, $3, NULL)
           ON CONFLICT (meetup_event_id) DO UPDATE
             SET latest_snapshot_id = EXCLUDED.latest_snapshot_id,
                 last_seen_at = EXCLUDED.last_seen_at,
                 deleted_at = NULL`,
            [o.eventId, Number(snapshot.rows[0].id), write.startedAt],
          );
        }
        if (write.deletedEventIds.length > 0) {
          await client.query(
            `UPDATE event_audit_state SET deleted_at = $2
            WHERE meetup_event_id = ANY($1) AND deleted_at IS NULL`,
            [write.deletedEventIds, write.finishedAt],
          );
        }
        const changes: EventChange[] = [];
        for (const c of write.changes) {
          // eslint-disable-next-line no-await-in-loop -- one transaction, a handful of rows
          const { rows } = await client.query<ChangeRow>(
            `INSERT INTO event_changes
             (run_id, meetup_event_id, detected_at, kind, old_value, new_value, title, start_at,
              event_url, hosts, rsvp_yes, waitlist)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10::jsonb, $11, $12)
           RETURNING *`,
            [
              runId,
              c.eventId,
              write.finishedAt,
              c.kind,
              json(c.oldValue),
              json(c.newValue),
              c.title,
              c.startAt,
              c.eventUrl,
              json(c.hosts),
              c.rsvpYes,
              c.waitlist,
            ],
          );
          changes.push(toChange(rows[0]));
        }
        return { runId, changes };
      },
    );
  }

  /** A run that read or wrote nothing usable; for the page's "last snapshot" line and the due rule. */
  async recordFailedRun(
    startedAt: Date,
    finishedAt: Date,
    requestedBy: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO event_audit_runs (started_at, finished_at, requested_by, outcome)
       VALUES ($1, $2, $3, 'failed')`,
      [startedAt, finishedAt, requestedBy],
    );
  }

  /** Changes of these kinds not yet alerted, oldest first. */
  async unalerted(
    kinds: EventChangeKind[],
    limit = 50,
  ): Promise<EventChange[]> {
    if (kinds.length === 0) {
      return [];
    }
    const { rows } = await this.pool.query<ChangeRow>(
      `SELECT * FROM event_changes
        WHERE alerted_at IS NULL AND kind = ANY($1)
        ORDER BY id ASC LIMIT $2`,
      [kinds, limit],
    );
    return rows.map(toChange);
  }

  async markAlerted(ids: number[], at: Date): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.pool.query(
      'UPDATE event_changes SET alerted_at = $2 WHERE id = ANY($1) AND alerted_at IS NULL',
      [ids, at],
    );
  }

  /**
   * Retention, in bounded statements: superseded snapshots older than the
   * retention period, changes older than it, then events whose latest
   * snapshot is older than it (state and that snapshot). Returns the counts
   * of the first three.
   */
  async prune(
    now: Date,
    limit = 5000,
  ): Promise<{ snapshots: number; changes: number; states: number }> {
    const cutoff = new Date(
      now.getTime() - EVENT_AUDIT_RETENTION_DAYS * 86_400_000,
    );
    const snapshots = await this.pool.query(
      `DELETE FROM event_snapshots WHERE id IN (
         SELECT s.id FROM event_snapshots s
          WHERE s.taken_at < $1
            AND NOT EXISTS (SELECT 1 FROM event_audit_state st WHERE st.latest_snapshot_id = s.id)
          LIMIT $2)`,
      [cutoff, limit],
    );
    const changes = await this.pool.query(
      `DELETE FROM event_changes WHERE id IN (
         SELECT id FROM event_changes WHERE detected_at < $1 LIMIT $2)`,
      [cutoff, limit],
    );
    const states = await inDashboardTransaction(
      this.pool,
      'event audit state prune',
      async (client) => {
        const gone = await client.query<{ latest_snapshot_id: string }>(
          `DELETE FROM event_audit_state WHERE meetup_event_id IN (
             SELECT st.meetup_event_id FROM event_audit_state st
               JOIN event_snapshots s ON s.id = st.latest_snapshot_id
              WHERE s.taken_at < $1 LIMIT $2)
           RETURNING latest_snapshot_id`,
          [cutoff, limit],
        );
        if (gone.rows.length > 0) {
          await client.query('DELETE FROM event_snapshots WHERE id = ANY($1)', [
            gone.rows.map((r) => Number(r.latest_snapshot_id)),
          ]);
        }
        return gone.rowCount ?? 0;
      },
    );
    return {
      snapshots: snapshots.rowCount ?? 0,
      changes: changes.rowCount ?? 0,
      states,
    };
  }

  /** The page's list: newest first, every filter optional. */
  async listChanges(
    filter: ChangeFilter,
    limit = DEFAULT_PAGE,
  ): Promise<EventChange[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (filter.kind !== undefined) {
      add('kind = ?', filter.kind);
    }
    if (filter.hostId !== undefined) {
      if (!EVENT_ID.test(filter.hostId)) {
        return [];
      }
      add('hosts @> ?::jsonb', JSON.stringify([{ id: filter.hostId }]));
    }
    if (filter.from !== undefined) {
      add('detected_at >= ?', filter.from);
    }
    if (filter.to !== undefined) {
      add('detected_at < ?', filter.to);
    }
    if (filter.beforeId !== undefined) {
      add('id < ?', filter.beforeId);
    }
    params.push(limit);
    const { rows } = await this.pool.query<ChangeRow>(
      `SELECT * FROM event_changes
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toChange);
  }

  /** One event: its state, changes and snapshots (newest first); undefined when never seen. */
  async eventHistory(
    eventId: string,
    snapshotLimit = 200,
  ): Promise<EventHistory | undefined> {
    if (!EVENT_ID.test(eventId)) {
      return undefined;
    }
    const state = await this.pool.query<StateRow>(
      `${STATE_SELECT} WHERE st.meetup_event_id = $1`,
      [eventId],
    );
    if (state.rows[0] === undefined) {
      return undefined;
    }
    const [changes, snapshots] = await Promise.all([
      this.pool.query<ChangeRow>(
        'SELECT * FROM event_changes WHERE meetup_event_id = $1 ORDER BY id DESC LIMIT 500',
        [eventId],
      ),
      this.pool.query<SnapshotRow>(
        `SELECT ${SNAPSHOT_COLUMNS} FROM event_snapshots s
          WHERE s.meetup_event_id = $1 ORDER BY s.taken_at DESC, s.id DESC LIMIT $2`,
        [eventId, snapshotLimit],
      ),
    ]);
    return {
      state: toState(state.rows[0]),
      changes: changes.rows.map(toChange),
      snapshots: snapshots.rows.map(toSnapshot),
    };
  }

  /**
   * The host dashboard's hook: changes on events the member hosted (at the
   * time of the change), newest first. No UI in this PR.
   */
  async recentChangesForHost(
    meetupId: string,
    options: { limit?: number; since?: Date } = {},
  ): Promise<EventChange[]> {
    if (!EVENT_ID.test(meetupId)) {
      return [];
    }
    return this.listChanges(
      { hostId: meetupId, from: options.since },
      options.limit ?? 20,
    );
  }
}

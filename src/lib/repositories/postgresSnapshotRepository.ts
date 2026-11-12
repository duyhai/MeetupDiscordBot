import pg from 'pg';

import { SnapshotEvent, SnapshotRsvp } from '../snapshot/meetup.js';
import { dashboardPool, inDashboardTransaction } from './dashboardPool.js';

export type SnapshotKind = 'full' | 'incremental';

export interface SnapshotRun {
  id: number;
  /** 'job', or the Discord id of the staff member who asked for it. */
  trigger: string;
  kind: SnapshotKind;
  startedAt: Date;
  finishedAt: Date | undefined;
  /** When this run's listing phase finished; undefined before. */
  listedAt: Date | undefined;
  eventsListed: number;
  eventsFetched: number;
  rsvpsStored: number;
  failed: number;
  requests: number;
  /** An error class name (or 'ShortListing'), never a message. */
  lastError: string | undefined;
}

export interface SnapshotDelta {
  eventsFetched: number;
  rsvpsStored: number;
  failed: number;
}

export interface RsvpWork {
  eventId: string;
  dateTime: Date;
  /** Meetup's YES + ATTENDED total from the listing. */
  yesCount: number | null;
}

export interface RsvpWorkQuery {
  runStartedAt: Date;
  now: Date;
  settleDays: number;
}

/**
 * The group snapshot's durable state (meetup_events, meetup_event_rsvps,
 * meetup_snapshot_runs). The tick (src/lib/snapshot/ingest.ts) and the
 * staff card read and write it through this interface; tests use an
 * in-memory one.
 */
export interface SnapshotStore {
  openRun(): Promise<SnapshotRun | undefined>;
  lastFinishedRun(): Promise<SnapshotRun | undefined>;
  hasFinishedFull(): Promise<boolean>;
  /** undefined when a run is already open. */
  startRun(
    trigger: string,
    kind: SnapshotKind,
  ): Promise<SnapshotRun | undefined>;
  /** Non-deleted events stored with status PAST. */
  pastEventCount(): Promise<number>;
  upsertEvents(events: SnapshotEvent[], listedAt: Date): Promise<void>;
  /** deleted_at = at on non-deleted, non-ACTIVE rows last listed before `before`. */
  markDelisted(before: Date, at: Date): Promise<number>;
  /** deleted_at from the event audit's confirmed deletions. */
  markAuditDeletions(): Promise<number>;
  /** deleted_at = at on one event (a by-id read answered null). */
  markDeleted(eventId: string, at: Date): Promise<void>;
  markListed(
    runId: number,
    listedAt: Date,
    eventsListed: number,
  ): Promise<void>;
  /**
   * PAST, not deleted, not failed during this run, and never read, read
   * before it happened, or within `settleDays` and read before this run
   * started. Oldest first.
   */
  eventsNeedingRsvps(
    query: RsvpWorkQuery & { limit: number },
  ): Promise<RsvpWork[]>;
  pendingRsvpCount(query: RsvpWorkQuery): Promise<number>;
  /** rsvp_failures + 1, rsvp_failed_at = at, rsvp_error = the class name. */
  recordRsvpFailure(
    eventId: string,
    errorName: string,
    at: Date,
  ): Promise<void>;
  /** Live events whose last RSVP read failed. */
  failingEventCount(): Promise<number>;
  /** One transaction: the event's rows replaced by these, rsvps_fetched_at set, failures cleared. */
  replaceRsvps(
    eventId: string,
    rsvps: SnapshotRsvp[],
    fetchedAt: Date,
  ): Promise<void>;
  advance(runId: number, delta: SnapshotDelta): Promise<void>;
  recordRequests(runId: number, calls: number): Promise<void>;
  /** last_error on the run; undefined clears it. */
  recordError(runId: number, errorName: string | undefined): Promise<void>;
  finishRun(runId: number): Promise<SnapshotRun | undefined>;
  totals(): Promise<{ events: number; rsvps: number }>;
}

interface RunRow {
  id: number;
  trigger: string;
  kind: SnapshotKind;
  started_at: Date;
  finished_at: Date | null;
  listed_at: Date | null;
  events_listed: number;
  events_fetched: number;
  rsvps_stored: number;
  failed: number;
  requests: number;
  last_error: string | null;
}

const RUN_COLUMNS =
  'id, trigger, kind, started_at, finished_at, listed_at, events_listed, events_fetched, rsvps_stored, failed, requests, last_error';

function toRun(row: RunRow): SnapshotRun {
  return {
    id: row.id,
    trigger: row.trigger,
    kind: row.kind,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    listedAt: row.listed_at ?? undefined,
    eventsListed: row.events_listed,
    eventsFetched: row.events_fetched,
    rsvpsStored: row.rsvps_stored,
    failed: row.failed,
    requests: row.requests,
    lastError: row.last_error ?? undefined,
  };
}

/** The work-set predicate; $1 run start, $2 now, $3 settle days. */
const NEEDS_RSVPS = `deleted_at IS NULL AND status = 'PAST' AND date_time <= $2
  AND (rsvp_failed_at IS NULL OR rsvp_failed_at < $1)
  AND (rsvps_fetched_at IS NULL
       OR rsvps_fetched_at < date_time
       OR (date_time > $2 - make_interval(days => $3) AND rsvps_fetched_at < $1))`;

export class PostgresSnapshotRepository implements SnapshotStore {
  private static singleton: Promise<PostgresSnapshotRepository> | undefined;

  constructor(private readonly pool: pg.Pool) {}

  static instance(): Promise<PostgresSnapshotRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(
        (pool) => new PostgresSnapshotRepository(pool),
      );
      this.singleton = pending;
      pending.catch(() => {
        if (this.singleton === pending) {
          this.singleton = undefined;
        }
      });
    }
    return this.singleton;
  }

  async openRun(): Promise<SnapshotRun | undefined> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM meetup_snapshot_runs WHERE finished_at IS NULL LIMIT 1`,
    );
    return result.rows[0] ? toRun(result.rows[0]) : undefined;
  }

  async lastFinishedRun(): Promise<SnapshotRun | undefined> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM meetup_snapshot_runs
        WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 1`,
    );
    return result.rows[0] ? toRun(result.rows[0]) : undefined;
  }

  async hasFinishedFull(): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM meetup_snapshot_runs
        WHERE kind = 'full' AND finished_at IS NOT NULL LIMIT 1`,
    );
    return (result.rowCount ?? 0) > 0;
  }

  async startRun(
    trigger: string,
    kind: SnapshotKind,
  ): Promise<SnapshotRun | undefined> {
    // The partial unique index refuses a second open row (as the backfill's).
    try {
      const result = await this.pool.query<RunRow>(
        `INSERT INTO meetup_snapshot_runs (trigger, kind)
         VALUES ($1, $2) RETURNING ${RUN_COLUMNS}`,
        [trigger, kind],
      );
      return toRun(result.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return undefined;
      }
      throw error;
    }
  }

  async pastEventCount(): Promise<number> {
    const result = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM meetup_events
        WHERE status = 'PAST' AND deleted_at IS NULL`,
    );
    return Number(result.rows[0].n);
  }

  async upsertEvents(events: SnapshotEvent[], listedAt: Date): Promise<void> {
    if (events.length === 0) {
      return;
    }
    // Host ids travel as one comma-joined text per event (digits only, by
    // validation), since unnest cannot take a ragged text[][].
    await this.pool.query(
      `INSERT INTO meetup_events
         (event_id, title, date_time, event_url, status, host_ids,
          yes_count, waitlist_count, listed_at)
       SELECT e.id, e.title, e.at, e.url, e.status,
              CASE WHEN e.hosts = '' THEN '{}'::text[] ELSE string_to_array(e.hosts, ',') END,
              e.yes, e.waitlist, $9
         FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::text[],
                     $5::text[], $6::text[], $7::int[], $8::int[])
              AS e(id, title, at, url, status, hosts, yes, waitlist)
       ON CONFLICT (event_id) DO UPDATE SET
         title = EXCLUDED.title, date_time = EXCLUDED.date_time,
         event_url = EXCLUDED.event_url, status = EXCLUDED.status,
         host_ids = EXCLUDED.host_ids, yes_count = EXCLUDED.yes_count,
         waitlist_count = EXCLUDED.waitlist_count, listed_at = EXCLUDED.listed_at,
         deleted_at = NULL`,
      [
        events.map((e) => e.eventId),
        events.map((e) => e.title),
        events.map((e) => e.dateTime),
        events.map((e) => e.eventUrl),
        events.map((e) => e.status),
        events.map((e) => e.hostIds.join(',')),
        events.map((e) => e.yesCount),
        events.map((e) => e.waitlistCount),
        listedAt,
      ],
    );
  }

  async markDelisted(before: Date, at: Date): Promise<number> {
    const result = await this.pool.query(
      `UPDATE meetup_events SET deleted_at = $2
        WHERE deleted_at IS NULL AND status <> 'ACTIVE' AND listed_at < $1`,
      [before, at],
    );
    return result.rowCount ?? 0;
  }

  async markAuditDeletions(): Promise<number> {
    // The audit's table lives in its own schema SQL; absent until the
    // audit has booted once, and then there is nothing to copy.
    const exists = await this.pool.query<{ t: string | null }>(
      `SELECT to_regclass('event_audit_state')::text AS t`,
    );
    if (exists.rows[0]?.t == null) {
      return 0;
    }
    const result = await this.pool.query(
      `UPDATE meetup_events e SET deleted_at = s.deleted_at
         FROM event_audit_state s
        WHERE s.meetup_event_id = e.event_id
          AND s.deleted_at IS NOT NULL AND e.deleted_at IS NULL`,
    );
    return result.rowCount ?? 0;
  }

  async markDeleted(eventId: string, at: Date): Promise<void> {
    await this.pool.query(
      'UPDATE meetup_events SET deleted_at = $2 WHERE event_id = $1 AND deleted_at IS NULL',
      [eventId, at],
    );
  }

  async markListed(
    runId: number,
    listedAt: Date,
    eventsListed: number,
  ): Promise<void> {
    await this.pool.query(
      'UPDATE meetup_snapshot_runs SET listed_at = $2, events_listed = $3 WHERE id = $1',
      [runId, listedAt, eventsListed],
    );
  }

  async eventsNeedingRsvps(
    query: RsvpWorkQuery & { limit: number },
  ): Promise<RsvpWork[]> {
    const result = await this.pool.query<{
      event_id: string;
      date_time: Date;
      yes_count: number | null;
    }>(
      `SELECT event_id, date_time, yes_count FROM meetup_events
        WHERE ${NEEDS_RSVPS}
        ORDER BY date_time, event_id LIMIT $4`,
      [query.runStartedAt, query.now, query.settleDays, query.limit],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      dateTime: row.date_time,
      yesCount: row.yes_count,
    }));
  }

  async recordRsvpFailure(
    eventId: string,
    errorName: string,
    at: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE meetup_events
          SET rsvp_failures = rsvp_failures + 1, rsvp_failed_at = $2, rsvp_error = $3
        WHERE event_id = $1`,
      [eventId, at, errorName.slice(0, 100)],
    );
  }

  async failingEventCount(): Promise<number> {
    const result = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM meetup_events
        WHERE rsvp_failures > 0 AND deleted_at IS NULL`,
    );
    return Number(result.rows[0].n);
  }

  async pendingRsvpCount(query: RsvpWorkQuery): Promise<number> {
    const result = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM meetup_events WHERE ${NEEDS_RSVPS}`,
      [query.runStartedAt, query.now, query.settleDays],
    );
    return Number(result.rows[0].n);
  }

  async replaceRsvps(
    eventId: string,
    rsvps: SnapshotRsvp[],
    fetchedAt: Date,
  ): Promise<void> {
    // Last wins for a member listed twice (a page boundary moving under us).
    const byMember = new Map(rsvps.map((r) => [r.memberId, r.status]));
    await inDashboardTransaction(
      this.pool,
      'snapshot RSVP replace',
      async (client) => {
        await client.query(
          'DELETE FROM meetup_event_rsvps WHERE event_id = $1',
          [eventId],
        );
        if (byMember.size > 0) {
          await client.query(
            `INSERT INTO meetup_event_rsvps (event_id, member_id, status, fetched_at)
             SELECT $1, m, s, $4 FROM unnest($2::text[], $3::text[]) AS r(m, s)`,
            [eventId, [...byMember.keys()], [...byMember.values()], fetchedAt],
          );
        }
        await client.query(
          `UPDATE meetup_events
              SET rsvps_fetched_at = $2, rsvp_failures = 0, rsvp_failed_at = NULL, rsvp_error = NULL
            WHERE event_id = $1`,
          [eventId, fetchedAt],
        );
      },
    );
  }

  async advance(runId: number, delta: SnapshotDelta): Promise<void> {
    await this.pool.query(
      `UPDATE meetup_snapshot_runs
          SET events_fetched = events_fetched + $2,
              rsvps_stored = rsvps_stored + $3,
              failed = failed + $4
        WHERE id = $1`,
      [runId, delta.eventsFetched, delta.rsvpsStored, delta.failed],
    );
  }

  async recordRequests(runId: number, calls: number): Promise<void> {
    await this.pool.query(
      'UPDATE meetup_snapshot_runs SET requests = requests + $2 WHERE id = $1',
      [runId, calls],
    );
  }

  async recordError(
    runId: number,
    errorName: string | undefined,
  ): Promise<void> {
    await this.pool.query(
      'UPDATE meetup_snapshot_runs SET last_error = $2 WHERE id = $1',
      [runId, errorName?.slice(0, 100) ?? null],
    );
  }

  async finishRun(runId: number): Promise<SnapshotRun | undefined> {
    const result = await this.pool.query<RunRow>(
      `UPDATE meetup_snapshot_runs SET finished_at = now()
        WHERE id = $1 AND finished_at IS NULL RETURNING ${RUN_COLUMNS}`,
      [runId],
    );
    return result.rows[0] ? toRun(result.rows[0]) : undefined;
  }

  async totals(): Promise<{ events: number; rsvps: number }> {
    const result = await this.pool.query<{ events: string; rsvps: string }>(
      `SELECT (SELECT count(*) FROM meetup_events)::text AS events,
              (SELECT count(*) FROM meetup_event_rsvps)::text AS rsvps`,
    );
    return {
      events: Number(result.rows[0].events),
      rsvps: Number(result.rows[0].rsvps),
    };
  }
}

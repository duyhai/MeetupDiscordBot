import pg from 'pg';

import {
  DASHBOARD_LOCK_CLASS,
  dashboardPool,
  DashboardTransactionOptions,
  inDashboardTransaction,
  SCHEMA_LOCK_KEY,
} from './dashboardPool.js';

const EVENT_ID = /^[0-9]{1,20}$/;
const MEETUP_ID_SQL = `'^[1-9][0-9]{0,19}$'`;
export const ANNOUNCE_FAILURE_MAX = 1000;
/** A `sending` row older than this is a call that was cut off. */
export const SENDING_STALE_MS = 2 * 60 * 1000;

/**
 * True when the row's send was cut off (a restart mid-call). The page reads
 * this with the dyno's clock, the claim with the database's now(), and at
 * exactly 2 minutes the page offers a retry a moment before the claim takes
 * it: that only answers "in progress" once. A call still running after 2
 * minutes can be claimed again too; Meetup refuses a second announcement,
 * so that is fine.
 */
export function isStaleSending(a: Announcement, now: Date): boolean {
  return (
    a.status === 'sending' &&
    now.getTime() - a.requestedAt.getTime() >= SENDING_STALE_MS
  );
}

/**
 * - held: scheduled for `dueAt` (the work-hours hold or the spacing rule,
 *   announceSchedule.ts); the tick sends it when due. The host may cancel it.
 * - sending: claimed, Meetup not answered yet (or the dyno stopped mid-call:
 *   after SENDING_STALE_MS it counts as unconfirmed).
 * - sent: Meetup announced it (or said it already was).
 * - failed: Meetup refused it.
 * - unknown: the call broke without an answer.
 * - cancelled: the host cancelled it while held.
 * Anything but `sent`, `held` and a fresh `sending` may be tried again:
 * Meetup refuses a second announcement itself, so the row is a record for
 * the page and the alerts, not a lock. It only keeps quick repeat clicks to
 * one call.
 */
export type AnnouncementStatus =
  'held' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled';

export interface Announcement {
  meetupEventId: string;
  requestedBy: string;
  status: AnnouncementStatus;
  failure: string | null;
  requestedAt: Date;
  completedAt: Date | null;
  /** When a held one goes out; null otherwise. */
  dueAt: Date | null;
}

/** A recreated event: the old one, cancelled, and the new one announced instead. */
export interface Recreation {
  oldEventId: string;
  newEventId: string;
  requestedBy: string;
  createdAt: Date;
}

/**
 * Idempotent; runs under the dashboard schema lock. One row per Meetup
 * event: its latest announcement and how it went.
 */
export const EVENT_ANNOUNCEMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS event_announcements (
  meetup_event_id TEXT PRIMARY KEY CHECK (meetup_event_id ~ '^[0-9]{1,20}$'),
  requested_by    TEXT NOT NULL CHECK (requested_by ~ ${MEETUP_ID_SQL}),
  status          TEXT NOT NULL,
  failure         TEXT CHECK (failure IS NULL OR length(failure) <= ${ANNOUNCE_FAILURE_MAX}),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  due_at          TIMESTAMPTZ
);
ALTER TABLE event_announcements ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
ALTER TABLE event_announcements DROP CONSTRAINT IF EXISTS event_announcements_status_check;
ALTER TABLE event_announcements ADD CONSTRAINT event_announcements_status_check
  CHECK (status IN ('held', 'sending', 'sent', 'failed', 'unknown', 'cancelled'));
CREATE INDEX IF NOT EXISTS event_announcements_due_idx
  ON event_announcements (due_at) WHERE status = 'held';
CREATE TABLE IF NOT EXISTS event_recreations (
  old_event_id TEXT PRIMARY KEY CHECK (old_event_id ~ '^[0-9]{1,20}$'),
  new_event_id TEXT NOT NULL UNIQUE CHECK (new_event_id ~ '^[0-9]{1,20}$'),
  requested_by TEXT NOT NULL CHECK (requested_by ~ ${MEETUP_ID_SQL}),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function ensureEventAnnouncementSchema(
  pool: pg.Pool,
  options: DashboardTransactionOptions = {},
): Promise<void> {
  await inDashboardTransaction(
    pool,
    'event announcement schema transaction',
    async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        DASHBOARD_LOCK_CLASS,
        SCHEMA_LOCK_KEY,
      ]);
      await client.query(EVENT_ANNOUNCEMENT_SCHEMA_SQL);
    },
    options,
  );
}

interface Row {
  meetup_event_id: string;
  requested_by: string;
  status: AnnouncementStatus;
  failure: string | null;
  requested_at: Date;
  completed_at: Date | null;
  due_at: Date | null;
}

const toAnnouncement = (r: Row): Announcement => ({
  meetupEventId: r.meetup_event_id,
  requestedBy: r.requested_by,
  status: r.status,
  failure: r.failure,
  requestedAt: r.requested_at,
  completedAt: r.completed_at,
  dueAt: r.due_at,
});

/** Rows a new request may take over: a refusal, no answer, a cancelled hold, or a send cut off. */
const RECLAIMABLE_SQL = `(event_announcements.status IN ('failed', 'unknown', 'cancelled')
            OR (event_announcements.status = 'sending'
                AND event_announcements.requested_at
                    < now() - make_interval(secs => $3)))`;

/** event_announcements on the dashboard pool. */
export class PostgresEventAnnouncementRepository {
  private static singleton:
    Promise<PostgresEventAnnouncementRepository> | undefined;

  constructor(private readonly pool: pg.Pool) {}

  static instance(): Promise<PostgresEventAnnouncementRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(async (pool) => {
        await ensureEventAnnouncementSchema(pool);
        return new PostgresEventAnnouncementRepository(pool);
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

  /**
   * Claims a send now: a new row as `sending`, or a reclaimable row (not
   * sent, not held, not freshly sending) back to `sending`. One statement,
   * so of clicks at once exactly one calls Meetup. Otherwise the row as it
   * stands (sent, held, or another send under way); the caller sends nothing.
   */
  async claim(
    meetupEventId: string,
    requestedBy: string,
  ): Promise<{ claimed: true } | { claimed: false; current: Announcement }> {
    if (!EVENT_ID.test(meetupEventId)) {
      throw new RangeError('not a Meetup event id');
    }
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO event_announcements (meetup_event_id, requested_by, status)
       VALUES ($1, $2, 'sending')
       ON CONFLICT (meetup_event_id) DO UPDATE
         SET status = 'sending', requested_by = EXCLUDED.requested_by,
             requested_at = now(), failure = NULL, completed_at = NULL,
             due_at = NULL
         WHERE ${RECLAIMABLE_SQL}
       RETURNING *`,
      [meetupEventId, requestedBy, SENDING_STALE_MS / 1000],
    );
    if (rows[0] !== undefined) {
      return { claimed: true };
    }
    return { claimed: false, current: await this.mustGet(meetupEventId) };
  }

  /**
   * Schedules a send: like claim, but the row becomes `held` for `dueAt`
   * (the tick sends it). Same reclaim rule; a row already held, sent or
   * sending is returned as it stands and nothing changes.
   */
  async hold(
    meetupEventId: string,
    requestedBy: string,
    dueAt: Date,
  ): Promise<{ held: true } | { held: false; current: Announcement }> {
    if (!EVENT_ID.test(meetupEventId)) {
      throw new RangeError('not a Meetup event id');
    }
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO event_announcements (meetup_event_id, requested_by, status, due_at)
       VALUES ($1, $2, 'held', $4)
       ON CONFLICT (meetup_event_id) DO UPDATE
         SET status = 'held', requested_by = EXCLUDED.requested_by,
             requested_at = now(), failure = NULL, completed_at = NULL,
             due_at = EXCLUDED.due_at
         WHERE ${RECLAIMABLE_SQL}
       RETURNING *`,
      [meetupEventId, requestedBy, SENDING_STALE_MS / 1000, dueAt],
    );
    if (rows[0] !== undefined) {
      return { held: true };
    }
    return { held: false, current: await this.mustGet(meetupEventId) };
  }

  /** Cancels a held send; false when the row is not held (nothing changes). */
  async cancelHeld(meetupEventId: string): Promise<boolean> {
    if (!EVENT_ID.test(meetupEventId)) {
      return false;
    }
    const { rowCount } = await this.pool.query(
      `UPDATE event_announcements
          SET status = 'cancelled', completed_at = now()
        WHERE meetup_event_id = $1 AND status = 'held'`,
      [meetupEventId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Held rows whose time has come, earliest first. */
  async due(now: Date, limit = 20): Promise<Announcement[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM event_announcements
        WHERE status = 'held' AND due_at <= $1
        ORDER BY due_at, meetup_event_id
        LIMIT $2`,
      [now, limit],
    );
    return rows.map(toAnnouncement);
  }

  /**
   * The tick's claim: a held row whose time has come becomes `sending`.
   * False when it is no longer held or not yet due (another tick took it,
   * or the host cancelled it), so a re-tick sends nothing twice.
   */
  async claimHeld(meetupEventId: string, now: Date): Promise<boolean> {
    if (!EVENT_ID.test(meetupEventId)) {
      return false;
    }
    const { rowCount } = await this.pool.query(
      `UPDATE event_announcements
          SET status = 'sending', requested_at = now()
        WHERE meetup_event_id = $1 AND status = 'held' AND due_at <= $2`,
      [meetupEventId, now],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * When other announcements go or went out, for the spacing rule: held
   * ones at their due time, sends under way and sent ones at their time,
   * from `since` on. Never this event's own row.
   */
  async otherTimes(exceptEventId: string, since: Date): Promise<Date[]> {
    const { rows } = await this.pool.query<{ at: Date }>(
      `SELECT COALESCE(due_at, completed_at, requested_at) AS at
         FROM event_announcements
        WHERE meetup_event_id <> $1
          AND status IN ('held', 'sending', 'sent')
          AND COALESCE(due_at, completed_at, requested_at) >= $2`,
      [exceptEventId, since],
    );
    return rows.map((r) => r.at);
  }

  private async mustGet(meetupEventId: string): Promise<Announcement> {
    const current = await this.get(meetupEventId);
    if (current === undefined) {
      // Only a row deleted in between (nothing here deletes).
      throw new Error('Announcement row vanished');
    }
    return current;
  }

  /** How a claimed announcement ended; only a `sending` row changes. */
  async finish(
    meetupEventId: string,
    status: Exclude<AnnouncementStatus, 'sending'>,
    failure: string | null = null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE event_announcements
          SET status = $2, failure = $3, completed_at = now()
        WHERE meetup_event_id = $1 AND status = 'sending'`,
      [
        meetupEventId,
        status,
        failure === null
          ? null
          : Array.from(failure).slice(0, ANNOUNCE_FAILURE_MAX).join(''),
      ],
    );
  }

  async get(meetupEventId: string): Promise<Announcement | undefined> {
    if (!EVENT_ID.test(meetupEventId)) {
      return undefined;
    }
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM event_announcements WHERE meetup_event_id = $1',
      [meetupEventId],
    );
    return rows[0] ? toAnnouncement(rows[0]) : undefined;
  }

  /** Records that `newEventId` replaces `oldEventId`; false when the old one was recreated before. */
  async recordRecreation(
    oldEventId: string,
    newEventId: string,
    requestedBy: string,
  ): Promise<boolean> {
    if (!EVENT_ID.test(oldEventId) || !EVENT_ID.test(newEventId)) {
      throw new RangeError('not a Meetup event id');
    }
    const { rowCount } = await this.pool.query(
      `INSERT INTO event_recreations (old_event_id, new_event_id, requested_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (old_event_id) DO NOTHING`,
      [oldEventId, newEventId, requestedBy],
    );
    return (rowCount ?? 0) > 0;
  }

  async recreationOf(oldEventId: string): Promise<Recreation | undefined> {
    if (!EVENT_ID.test(oldEventId)) {
      return undefined;
    }
    const { rows } = await this.pool.query<{
      old_event_id: string;
      new_event_id: string;
      requested_by: string;
      created_at: Date;
    }>('SELECT * FROM event_recreations WHERE old_event_id = $1', [oldEventId]);
    const r = rows[0];
    return r
      ? {
          oldEventId: r.old_event_id,
          newEventId: r.new_event_id,
          requestedBy: r.requested_by,
          createdAt: r.created_at,
        }
      : undefined;
  }

  /** The rows for these events, by event id; events never announced are absent. */
  async forEvents(
    meetupEventIds: string[],
  ): Promise<Map<string, Announcement>> {
    const ids = meetupEventIds.filter((id) => EVENT_ID.test(id));
    if (ids.length === 0) {
      return new Map();
    }
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM event_announcements WHERE meetup_event_id = ANY($1)',
      [ids],
    );
    return new Map(rows.map((r) => [r.meetup_event_id, toAnnouncement(r)]));
  }
}

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

/** True when the row's send was cut off (a restart mid-call). */
export function isStaleSending(a: Announcement, now: Date): boolean {
  return (
    a.status === 'sending' &&
    now.getTime() - a.requestedAt.getTime() >= SENDING_STALE_MS
  );
}

/**
 * - sending: claimed, Meetup not answered yet (or the dyno stopped mid-call:
 *   after SENDING_STALE_MS it counts as unconfirmed).
 * - sent: Meetup announced it (or said it already was).
 * - failed: Meetup refused it.
 * - unknown: the call broke without an answer.
 * Anything but `sent` may be tried again: Meetup refuses a second
 * announcement itself, so the row is a record for the page and the alerts,
 * not a lock. It only keeps quick repeat clicks to one call.
 */
export type AnnouncementStatus = 'sending' | 'sent' | 'failed' | 'unknown';

export interface Announcement {
  meetupEventId: string;
  requestedBy: string;
  status: AnnouncementStatus;
  failure: string | null;
  requestedAt: Date;
  completedAt: Date | null;
}

/**
 * Idempotent; runs under the dashboard schema lock. One row per Meetup
 * event: its latest announcement and how it went.
 */
export const EVENT_ANNOUNCEMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS event_announcements (
  meetup_event_id TEXT PRIMARY KEY CHECK (meetup_event_id ~ '^[0-9]{1,20}$'),
  requested_by    TEXT NOT NULL CHECK (requested_by ~ ${MEETUP_ID_SQL}),
  status          TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'unknown')),
  failure         TEXT CHECK (failure IS NULL OR length(failure) <= ${ANNOUNCE_FAILURE_MAX}),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
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
}

const toAnnouncement = (r: Row): Announcement => ({
  meetupEventId: r.meetup_event_id,
  requestedBy: r.requested_by,
  status: r.status,
  failure: r.failure,
  requestedAt: r.requested_at,
  completedAt: r.completed_at,
});

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
   * Claims a send: a new row as `sending`, or any row not `sent` and not
   * freshly `sending` back to `sending`. One statement, so of clicks at
   * once exactly one calls Meetup. Otherwise the row as it stands (sent, or
   * another send under way); the caller sends nothing.
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
             requested_at = now(), failure = NULL, completed_at = NULL
         WHERE event_announcements.status IN ('failed', 'unknown')
            OR (event_announcements.status = 'sending'
                AND event_announcements.requested_at
                    < now() - make_interval(secs => $3))
       RETURNING *`,
      [meetupEventId, requestedBy, SENDING_STALE_MS / 1000],
    );
    if (rows[0] !== undefined) {
      return { claimed: true };
    }
    const current = await this.get(meetupEventId);
    if (current === undefined) {
      // Only a row deleted in between (nothing here deletes): say sending.
      throw new Error('Announcement row vanished');
    }
    return { claimed: false, current };
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

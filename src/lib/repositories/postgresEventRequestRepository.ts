import pg from 'pg';

import {
  DASHBOARD_LOCK_CLASS,
  dashboardPool,
  DashboardTransactionOptions,
  inDashboardTransaction,
  MEMBER_LOCK_CLASS,
  SCHEMA_LOCK_KEY,
} from './dashboardPool.js';

const DISCORD_ID_SQL = `'^[0-9]{17,20}$'`;
const MEETUP_ID_SQL = `'^[1-9][0-9]{0,19}$'`;
const REQUEST_ID = /^[1-9][0-9]{0,17}$/;
/** The create form's one-time token (base64url); see `submitToken`. */
export const SUBMIT_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const SUBMIT_TOKEN_SQL = `'^[A-Za-z0-9_-]{16,64}$'`;

export const EVENT_REQUEST_TITLE_MAX = 80;
export const DENY_REASON_MAX = 500;
export const FAILURE_MAX = 1000;

export const EVENT_REQUEST_STATUSES = [
  'pending',
  'publishing',
  'published',
  'failed',
  'denied',
] as const;
export type EventRequestStatus = (typeof EVENT_REQUEST_STATUSES)[number];

/** The states a publish may start from. 'publishing' only when stuck. */
export type PublishFrom = 'pending' | 'failed' | 'publishing';

/** What a host asks for; everything Meetup needs to create the event. */
export interface EventRequestFields {
  kind: 'fresh' | 'copy';
  sourceEventId: string | null;
  title: string;
  description: string;
  /** YYYY-MM-DDTHH:MM in the group's timezone, as Meetup takes it. */
  startLocal: string;
  duration: string;
  rsvpLimit: number;
  guestLimit: number;
  featuredPhotoId: number | null;
  venueId: string | null;
  howToFindUs: string | null;
}

export interface NewEventRequest extends EventRequestFields {
  meetupMemberId: string;
  discordUserId: string | null;
  hostName: string;
  tier: 'regular' | 'promoted';
  /**
   * The create form's one-time token: unique per host, so a form sent twice
   * (a double click, a reload) makes one request, not two.
   */
  submitToken?: string | null;
}

export interface EventRequest extends NewEventRequest {
  id: string;
  status: EventRequestStatus;
  denyReason: string | null;
  failure: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  meetupEventId: string | null;
  eventUrl: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Idempotent; runs under the dashboard schema lock. `event_requests` is one
 * row per request, its current state; `event_request_events` is the
 * append-only history of every change, with the version it produced.
 * `actor` is a Discord id (leadership), a Meetup id (the host) or 'system'.
 */
export const EVENT_REQUEST_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS event_requests (
  id                BIGSERIAL PRIMARY KEY,
  meetup_member_id  TEXT NOT NULL CHECK (meetup_member_id ~ ${MEETUP_ID_SQL}),
  discord_user_id   TEXT CHECK (discord_user_id ~ ${DISCORD_ID_SQL}),
  host_name         TEXT NOT NULL CHECK (length(host_name) BETWEEN 1 AND 100),
  tier              TEXT NOT NULL CHECK (tier IN ('regular', 'promoted')),
  kind              TEXT NOT NULL CHECK (kind IN ('fresh', 'copy')),
  source_event_id   TEXT CHECK (source_event_id ~ '^[A-Za-z0-9]{1,40}$'),
  title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND ${EVENT_REQUEST_TITLE_MAX}),
  description       TEXT NOT NULL CHECK (length(description) <= 50000),
  start_local       TEXT NOT NULL CHECK (start_local ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$'),
  duration          TEXT NOT NULL CHECK (duration ~ '^PT[0-9]{1,2}H([0-9]{1,2}M)?$'),
  rsvp_limit        INTEGER NOT NULL CHECK (rsvp_limit BETWEEN 1 AND 500),
  guest_limit       INTEGER NOT NULL CHECK (guest_limit BETWEEN 0 AND 10),
  featured_photo_id BIGINT,
  venue_id          TEXT CHECK (length(venue_id) BETWEEN 1 AND 40),
  how_to_find_us    TEXT CHECK (length(how_to_find_us) <= 2000),
  submit_token      TEXT CHECK (submit_token ~ ${SUBMIT_TOKEN_SQL}),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'publishing', 'published', 'failed', 'denied')),
  deny_reason       TEXT CHECK (length(deny_reason) BETWEEN 1 AND ${DENY_REASON_MAX}),
  failure           TEXT CHECK (length(failure) BETWEEN 1 AND ${FAILURE_MAX}),
  decided_by        TEXT,
  decided_at        TIMESTAMPTZ,
  meetup_event_id   TEXT CHECK (meetup_event_id ~ '^[0-9]{1,20}$'),
  event_url         TEXT,
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE event_requests
  ADD COLUMN IF NOT EXISTS submit_token TEXT CHECK (submit_token ~ ${SUBMIT_TOKEN_SQL});
CREATE UNIQUE INDEX IF NOT EXISTS event_requests_submit_token_idx
  ON event_requests (meetup_member_id, submit_token)
  WHERE submit_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_requests_member_idx
  ON event_requests (meetup_member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS event_requests_status_idx
  ON event_requests (status, created_at);
CREATE TABLE IF NOT EXISTS event_request_events (
  id          BIGSERIAL PRIMARY KEY,
  request_id  BIGINT NOT NULL REFERENCES event_requests (id),
  action      TEXT NOT NULL CHECK (action IN
                ('submit', 'start_publishing', 'created', 'published', 'failed', 'deny', 'resolve')),
  actor       TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 40),
  detail      TEXT CHECK (length(detail) <= ${FAILURE_MAX}),
  version     INTEGER NOT NULL CHECK (version >= 1),
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION event_request_events_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'event_request_events is append-only'; END $fn$;
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE t.tgname = 'event_request_events_append_only'
       AND c.relname = 'event_request_events'
       AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
  ) THEN
    CREATE TRIGGER event_request_events_append_only
      BEFORE UPDATE OR DELETE ON event_request_events
      FOR EACH ROW EXECUTE FUNCTION event_request_events_append_only();
  END IF;
END
$do$;
`;

/** EVENT_REQUEST_SCHEMA_SQL in one transaction under the dashboard schema lock. */
export async function ensureEventRequestSchema(
  pool: pg.Pool,
  options: DashboardTransactionOptions = {},
): Promise<void> {
  await inDashboardTransaction(
    pool,
    'event request schema transaction',
    async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        DASHBOARD_LOCK_CLASS,
        SCHEMA_LOCK_KEY,
      ]);
      await client.query(EVENT_REQUEST_SCHEMA_SQL);
    },
    options,
  );
}

interface Row {
  id: string;
  meetup_member_id: string;
  discord_user_id: string | null;
  host_name: string;
  tier: 'regular' | 'promoted';
  kind: 'fresh' | 'copy';
  source_event_id: string | null;
  title: string;
  description: string;
  start_local: string;
  duration: string;
  rsvp_limit: number;
  guest_limit: number;
  featured_photo_id: string | null;
  venue_id: string | null;
  how_to_find_us: string | null;
  submit_token: string | null;
  status: EventRequestStatus;
  deny_reason: string | null;
  failure: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  meetup_event_id: string | null;
  event_url: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const toRequest = (r: Row): EventRequest => ({
  id: String(r.id),
  meetupMemberId: r.meetup_member_id,
  discordUserId: r.discord_user_id,
  hostName: r.host_name,
  tier: r.tier,
  kind: r.kind,
  sourceEventId: r.source_event_id,
  title: r.title,
  description: r.description,
  startLocal: r.start_local,
  duration: r.duration,
  rsvpLimit: r.rsvp_limit,
  guestLimit: r.guest_limit,
  // BIGINT comes back as text; Meetup photo ids fit in a double.
  featuredPhotoId:
    r.featured_photo_id === null ? null : Number(r.featured_photo_id),
  venueId: r.venue_id,
  howToFindUs: r.how_to_find_us,
  submitToken: r.submit_token,
  status: r.status,
  denyReason: r.deny_reason,
  failure: r.failure,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  meetupEventId: r.meetup_event_id,
  eventUrl: r.event_url,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const isRequestId = (id: unknown): id is string =>
  typeof id === 'string' && REQUEST_ID.test(id);

type Action =
  | 'submit'
  | 'start_publishing'
  | 'created'
  | 'published'
  | 'failed'
  | 'deny'
  | 'resolve';

async function history(
  client: pg.PoolClient,
  row: Row,
  action: Action,
  actor: string,
  detail: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO event_request_events (request_id, action, actor, detail, version)
     VALUES ($1, $2, $3, $4, $5)`,
    [row.id, action, actor, detail, row.version],
  );
}

/**
 * Event requests from the host dashboard, on the dashboard pool. Every
 * state change is one transaction: the row's compare-and-set update and
 * its history row. The compare-and-set in startPublishing is what lets
 * exactly one approver publish a request.
 */
export class PostgresEventRequestRepository {
  private static singleton: Promise<PostgresEventRequestRepository> | undefined;

  constructor(private readonly pool: pg.Pool) {}

  static instance(): Promise<PostgresEventRequestRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(async (pool) => {
        await ensureEventRequestSchema(pool);
        return new PostgresEventRequestRepository(pool);
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

  private change(
    label: string,
    fn: (client: pg.PoolClient) => Promise<Row | undefined>,
    options: DashboardTransactionOptions = {},
  ): Promise<EventRequest | undefined> {
    return inDashboardTransaction(
      this.pool,
      label,
      async (client) => {
        const row = await fn(client);
        return row === undefined ? undefined : toRequest(row);
      },
      options,
    );
  }

  /**
   * Stores a new request. undefined when this host already sent a request
   * with the same `submitToken` (the same form sent twice): look it up with
   * findBySubmitToken. With `maxPending`, 'full' when the host already has
   * that many waiting: counted under a per-host lock, so two forms sent at
   * the same moment cannot both pass the cap.
   */
  async create(input: NewEventRequest): Promise<EventRequest | undefined>;
  async create(
    input: NewEventRequest,
    options: { maxPending?: number },
  ): Promise<EventRequest | undefined | 'full'>;
  async create(
    input: NewEventRequest,
    options: { maxPending?: number } = {},
  ): Promise<EventRequest | undefined | 'full'> {
    return inDashboardTransaction(
      this.pool,
      'event request create',
      async (c) => {
        if (options.maxPending !== undefined) {
          await c.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
            MEMBER_LOCK_CLASS,
            `event-request:${input.meetupMemberId}`,
          ]);
          const pending = await c.query<{ n: string }>(
            `SELECT count(*) AS n FROM event_requests
            WHERE meetup_member_id = $1 AND status = 'pending'`,
            [input.meetupMemberId],
          );
          if (Number(pending.rows[0].n) >= options.maxPending) {
            return 'full' as const;
          }
        }
        const { rows } = await c.query<Row>(
          `INSERT INTO event_requests
           (meetup_member_id, discord_user_id, host_name, tier, kind,
            source_event_id, title, description, start_local, duration,
            rsvp_limit, guest_limit, featured_photo_id, venue_id, how_to_find_us,
            submit_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (meetup_member_id, submit_token) WHERE submit_token IS NOT NULL
           DO NOTHING
         RETURNING *`,
          [
            input.meetupMemberId,
            input.discordUserId,
            input.hostName,
            input.tier,
            input.kind,
            input.sourceEventId,
            input.title,
            input.description,
            input.startLocal,
            input.duration,
            input.rsvpLimit,
            input.guestLimit,
            input.featuredPhotoId,
            input.venueId,
            input.howToFindUs,
            input.submitToken ?? null,
          ],
        );
        if (rows[0] === undefined) {
          return undefined;
        }
        await history(c, rows[0], 'submit', input.meetupMemberId);
        return toRequest(rows[0]);
      },
    );
  }

  /** The host's request made by the form with this token, if any. */
  async findBySubmitToken(
    meetupMemberId: string,
    submitToken: string,
  ): Promise<EventRequest | undefined> {
    if (!SUBMIT_TOKEN.test(submitToken)) {
      return undefined;
    }
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM event_requests
        WHERE meetup_member_id = $1 AND submit_token = $2`,
      [meetupMemberId, submitToken],
    );
    return rows[0] === undefined ? undefined : toRequest(rows[0]);
  }

  /** undefined for an unknown id or one that cannot be a request id. */
  async get(id: string): Promise<EventRequest | undefined> {
    if (!isRequestId(id)) {
      return undefined;
    }
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM event_requests WHERE id = $1',
      [id],
    );
    return rows[0] === undefined ? undefined : toRequest(rows[0]);
  }

  /** A host's requests, newest first. */
  async listForMember(
    meetupMemberId: string,
    limit = 20,
  ): Promise<EventRequest[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM event_requests WHERE meetup_member_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [meetupMemberId, limit],
    );
    return rows.map(toRequest);
  }

  /** How many of a host's requests are waiting for leadership. */
  async countPending(meetupMemberId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM event_requests
        WHERE meetup_member_id = $1 AND status = 'pending'`,
      [meetupMemberId],
    );
    return Number(rows[0].n);
  }

  /** Oldest first, so the queue is worked in the order requests came in. */
  async listByStatus(
    statuses: EventRequestStatus[],
    limit = 100,
  ): Promise<EventRequest[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM event_requests WHERE status = ANY($1::text[])
        ORDER BY created_at, id LIMIT $2`,
      [statuses, limit],
    );
    return rows.map(toRequest);
  }

  /** The latest decided requests (published, denied), newest first. */
  async listDecided(limit = 20): Promise<EventRequest[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM event_requests WHERE status IN ('published', 'denied')
        ORDER BY updated_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return rows.map(toRequest);
  }

  /**
   * The compare-and-set that admits exactly one publisher: the row moves to
   * 'publishing' only if it is still at `seenVersion` and in one of `from`.
   * A 'publishing' row counts only when last changed before `stuckBefore`
   * (its publisher died). undefined when another caller won or the row
   * moved on. The first approval records who decided and when.
   */
  startPublishing(
    id: string,
    seenVersion: number,
    actor: string,
    from: PublishFrom[],
    stuckBefore?: Date,
  ): Promise<EventRequest | undefined> {
    if (!isRequestId(id) || !Number.isInteger(seenVersion)) {
      return Promise.resolve(undefined);
    }
    const plain = from.filter((s) => s !== 'publishing');
    const stuck = from.includes('publishing') && stuckBefore !== undefined;
    return this.change('event request start publishing', async (c) => {
      const { rows } = await c.query<Row>(
        `UPDATE event_requests
            SET status = 'publishing', version = version + 1, updated_at = now(),
                failure = NULL,
                decided_by = COALESCE(decided_by, $3),
                decided_at = COALESCE(decided_at, now())
          WHERE id = $1 AND version = $2
            AND (status = ANY($4::text[])
                 OR ($5::boolean AND status = 'publishing' AND updated_at < $6))
          RETURNING *`,
        [id, seenVersion, actor, plain, stuck, stuckBefore ?? null],
      );
      if (rows[0] === undefined) {
        return undefined;
      }
      await history(c, rows[0], 'start_publishing', actor);
      return rows[0];
    });
  }

  /**
   * Records the Meetup event the moment it exists, so a retry resumes. Only
   * by the publisher that still owns the row (`version`, as its claim or
   * last step left it) and only once: false when another publisher took the
   * row over or an event is already recorded.
   */
  async recordCreated(
    id: string,
    version: number,
    meetupEventId: string,
    eventUrl: string,
  ): Promise<boolean> {
    if (!isRequestId(id)) {
      return false;
    }
    const row = await this.change('event request created', async (c) => {
      const { rows } = await c.query<Row>(
        `UPDATE event_requests
            SET meetup_event_id = $3, event_url = $4,
                version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 AND status = 'publishing'
            AND meetup_event_id IS NULL
          RETURNING *`,
        [id, version, meetupEventId, eventUrl],
      );
      if (rows[0] !== undefined) {
        await history(c, rows[0], 'created', 'system', meetupEventId);
      }
      return rows[0];
    });
    return row !== undefined;
  }

  /**
   * Ends a publish, only by the publisher that still owns the row
   * (`version`). undefined when the row moved on.
   */
  finish(
    id: string,
    version: number,
    outcome: { status: 'published' } | { status: 'failed'; failure: string },
  ): Promise<EventRequest | undefined> {
    if (!isRequestId(id)) {
      return Promise.resolve(undefined);
    }
    const failure =
      outcome.status === 'failed'
        ? Array.from(outcome.failure).slice(0, FAILURE_MAX).join('')
        : null;
    return this.change('event request finish', async (c) => {
      const { rows } = await c.query<Row>(
        `UPDATE event_requests
            SET status = $3, failure = $4, version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 AND status = 'publishing'
          RETURNING *`,
        [id, version, outcome.status, failure],
      );
      if (rows[0] !== undefined) {
        await history(c, rows[0], outcome.status, 'system', failure);
      }
      return rows[0];
    });
  }

  /**
   * Denies a request at `seenVersion`: a pending one, or a failed one with
   * no Meetup event recorded (so a request that cannot be published can
   * leave the queue). undefined when it moved on.
   */
  deny(
    id: string,
    seenVersion: number,
    actor: string,
    reason: string,
    options: DashboardTransactionOptions = {},
  ): Promise<EventRequest | undefined> {
    if (!isRequestId(id) || !Number.isInteger(seenVersion)) {
      return Promise.resolve(undefined);
    }
    return this.change(
      'event request deny',
      async (c) => {
        const { rows } = await c.query<Row>(
          `UPDATE event_requests
            SET status = 'denied', deny_reason = $4, decided_by = $3,
                decided_at = now(), version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2
            AND (status = 'pending'
                 OR (status = 'failed' AND meetup_event_id IS NULL))
          RETURNING *`,
          [id, seenVersion, actor, reason],
        );
        if (rows[0] !== undefined) {
          await history(c, rows[0], 'deny', actor, reason);
        }
        return rows[0];
      },
      options,
    );
  }

  /**
   * Marks a failed request whose event is on Meetup as published, once
   * leadership has fixed the event there by hand. The failure text stays in
   * the history. undefined when it moved on.
   */
  resolve(
    id: string,
    seenVersion: number,
    actor: string,
  ): Promise<EventRequest | undefined> {
    if (!isRequestId(id) || !Number.isInteger(seenVersion)) {
      return Promise.resolve(undefined);
    }
    return this.change('event request resolve', async (c) => {
      const { rows } = await c.query<Row>(
        `UPDATE event_requests
            SET status = 'published', failure = NULL, decided_by = $3,
                decided_at = now(), version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2
            AND status = 'failed' AND meetup_event_id IS NOT NULL
          RETURNING *`,
        [id, seenVersion, actor],
      );
      if (rows[0] !== undefined) {
        await history(c, rows[0], 'resolve', actor);
      }
      return rows[0];
    });
  }
}

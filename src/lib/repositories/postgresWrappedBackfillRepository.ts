import pg from 'pg';

import { dashboardPool } from './dashboardPool.js';

export interface BackfillRun {
  id: number;
  /** 'job', or the Discord id of the staff member who pressed Run now. */
  trigger: string;
  startedAt: Date;
  finishedAt: Date | undefined;
  membersTotal: number;
  membersDone: number;
  built: number;
  skipped: number;
  failed: number;
  /** The last Discord id processed; undefined before the first. */
  cursor: string | undefined;
}

export interface QueueRow {
  discordUserId: string;
  meetupId: string;
  year: number;
  queuedAt: Date;
  attempts: number;
}

export interface RunDelta {
  done: number;
  built: number;
  skipped: number;
  failed: number;
}

/**
 * The backfill's durable state: runs (one open at a time, resumable by
 * cursor) and the queue of throttled requests (one year per member). The
 * tick (backfill.ts) and the pages read and write it through this interface;
 * tests use an in-memory one.
 */
export interface WrappedBackfillStore {
  openRun(): Promise<BackfillRun | undefined>;
  lastFinishedRun(): Promise<BackfillRun | undefined>;
  /** undefined when a run is already open. */
  startRun(
    trigger: string,
    membersTotal: number,
  ): Promise<BackfillRun | undefined>;
  /**
   * Moves the cursor from `from` to `to` and adds the deltas; false when
   * another process moved it first (compare-and-set on the cursor).
   */
  advanceRun(
    id: number,
    from: string | undefined,
    to: string,
    delta: RunDelta,
  ): Promise<boolean>;
  finishRun(id: number): Promise<BackfillRun | undefined>;
  /** 'queued' on insert; the year already queued when the member has a row. */
  enqueue(row: {
    discordUserId: string;
    meetupId: string;
    year: number;
  }): Promise<'queued' | { already: number }>;
  /** 1-based position by queued_at among every row, with the row. */
  position(
    discordUserId: string,
  ): Promise<{ position: number; row: QueueRow } | undefined>;
  queueLength(): Promise<number>;
  /**
   * Oldest first: rows unclaimed, or claimed longer than `staleMs` ago (a
   * tick that died). Sets claimed_at; two ticks never get the same row.
   */
  claimNext(limit: number, staleMs: number): Promise<QueueRow[]>;
  complete(discordUserId: string): Promise<void>;
  /** attempts + 1, then released for the next tick, or dropped at `maxAttempts`. */
  release(
    discordUserId: string,
    maxAttempts: number,
  ): Promise<'released' | 'dropped'>;
}

interface RunRow {
  id: number;
  trigger: string;
  started_at: Date;
  finished_at: Date | null;
  members_total: number;
  members_done: number;
  built: number;
  skipped: number;
  failed: number;
  cursor: string | null;
}

interface QueueDbRow {
  discord_user_id: string;
  meetup_id: string;
  year: number;
  queued_at: Date;
  attempts: number;
}

const RUN_COLUMNS =
  'id, trigger, started_at, finished_at, members_total, members_done, built, skipped, failed, cursor';
const QUEUE_COLUMNS = 'discord_user_id, meetup_id, year, queued_at, attempts';

function toRun(row: RunRow): BackfillRun {
  return {
    id: row.id,
    trigger: row.trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    membersTotal: row.members_total,
    membersDone: row.members_done,
    built: row.built,
    skipped: row.skipped,
    failed: row.failed,
    cursor: row.cursor ?? undefined,
  };
}

function toQueueRow(row: QueueDbRow): QueueRow {
  return {
    discordUserId: row.discord_user_id,
    meetupId: row.meetup_id,
    year: row.year,
    queuedAt: row.queued_at,
    attempts: row.attempts,
  };
}

export class PostgresWrappedBackfillRepository implements WrappedBackfillStore {
  private static singleton:
    Promise<PostgresWrappedBackfillRepository> | undefined;

  constructor(private readonly pool: pg.Pool) {}

  static instance(): Promise<PostgresWrappedBackfillRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(
        (pool) => new PostgresWrappedBackfillRepository(pool),
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

  async openRun(): Promise<BackfillRun | undefined> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM wrapped_backfill_runs WHERE finished_at IS NULL LIMIT 1`,
    );
    return result.rows[0] ? toRun(result.rows[0]) : undefined;
  }

  async lastFinishedRun(): Promise<BackfillRun | undefined> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM wrapped_backfill_runs
        WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
    );
    return result.rows[0] ? toRun(result.rows[0]) : undefined;
  }

  async startRun(
    trigger: string,
    membersTotal: number,
  ): Promise<BackfillRun | undefined> {
    // The partial unique index refuses a second open row; ON CONFLICT
    // cannot name a partial index without its predicate, so the violation
    // is caught instead.
    try {
      const result = await this.pool.query<RunRow>(
        `INSERT INTO wrapped_backfill_runs (trigger, members_total)
         VALUES ($1, $2) RETURNING ${RUN_COLUMNS}`,
        [trigger, membersTotal],
      );
      return toRun(result.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return undefined;
      }
      throw error;
    }
  }

  async advanceRun(
    id: number,
    from: string | undefined,
    to: string,
    delta: RunDelta,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE wrapped_backfill_runs
          SET cursor = $3,
              members_done = members_done + $4,
              built = built + $5,
              skipped = skipped + $6,
              failed = failed + $7
        WHERE id = $1 AND finished_at IS NULL AND cursor IS NOT DISTINCT FROM $2`,
      [
        id,
        from ?? null,
        to,
        delta.done,
        delta.built,
        delta.skipped,
        delta.failed,
      ],
    );
    return result.rowCount === 1;
  }

  async finishRun(id: number): Promise<BackfillRun | undefined> {
    const result = await this.pool.query<RunRow>(
      `UPDATE wrapped_backfill_runs SET finished_at = now()
        WHERE id = $1 AND finished_at IS NULL RETURNING ${RUN_COLUMNS}`,
      [id],
    );
    return result.rows[0] ? toRun(result.rows[0]) : undefined;
  }

  async enqueue(row: {
    discordUserId: string;
    meetupId: string;
    year: number;
  }): Promise<'queued' | { already: number }> {
    const result = await this.pool.query<{ year: number; fresh: boolean }>(
      `INSERT INTO wrapped_queue AS q (discord_user_id, meetup_id, year)
       VALUES ($1, $2, $3)
       ON CONFLICT (discord_user_id) DO UPDATE SET meetup_id = q.meetup_id
       RETURNING year, (xmax = 0) AS fresh`,
      [row.discordUserId, row.meetupId, row.year],
    );
    const { year, fresh } = result.rows[0];
    return fresh ? 'queued' : { already: year };
  }

  async position(
    discordUserId: string,
  ): Promise<{ position: number; row: QueueRow } | undefined> {
    const result = await this.pool.query<QueueDbRow & { position: string }>(
      `SELECT ${QUEUE_COLUMNS}, position FROM (
         SELECT ${QUEUE_COLUMNS},
                row_number() OVER (ORDER BY queued_at, discord_user_id) AS position
           FROM wrapped_queue) ranked
        WHERE discord_user_id = $1`,
      [discordUserId],
    );
    const row = result.rows[0];
    return row
      ? { position: Number(row.position), row: toQueueRow(row) }
      : undefined;
  }

  async queueLength(): Promise<number> {
    const result = await this.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM wrapped_queue',
    );
    return Number(result.rows[0].n);
  }

  async claimNext(limit: number, staleMs: number): Promise<QueueRow[]> {
    const result = await this.pool.query<QueueDbRow>(
      `WITH next AS (
         SELECT discord_user_id FROM wrapped_queue
          WHERE claimed_at IS NULL
             OR claimed_at < now() - make_interval(secs => $2::double precision / 1000)
          ORDER BY queued_at, discord_user_id
          LIMIT $1
          FOR UPDATE SKIP LOCKED)
       UPDATE wrapped_queue q SET claimed_at = now()
         FROM next WHERE q.discord_user_id = next.discord_user_id
       RETURNING q.discord_user_id, q.meetup_id, q.year, q.queued_at, q.attempts`,
      [limit, staleMs],
    );
    return result.rows
      .map(toQueueRow)
      .sort(
        (a, b) =>
          a.queuedAt.getTime() - b.queuedAt.getTime() ||
          a.discordUserId.localeCompare(b.discordUserId),
      );
  }

  async complete(discordUserId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM wrapped_queue WHERE discord_user_id = $1',
      [discordUserId],
    );
  }

  async release(
    discordUserId: string,
    maxAttempts: number,
  ): Promise<'released' | 'dropped'> {
    const result = await this.pool.query<{ attempts: number }>(
      `UPDATE wrapped_queue SET attempts = attempts + 1, claimed_at = NULL
        WHERE discord_user_id = $1 RETURNING attempts`,
      [discordUserId],
    );
    const attempts = result.rows[0]?.attempts ?? maxAttempts;
    if (attempts >= maxAttempts) {
      await this.complete(discordUserId);
      return 'dropped';
    }
    return 'released';
  }
}

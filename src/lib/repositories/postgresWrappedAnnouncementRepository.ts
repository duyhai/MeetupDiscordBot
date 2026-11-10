import pg from 'pg';

import { dashboardPool } from './dashboardPool.js';

/**
 * An unposted claim older than this is taken to be a crash and is reclaimed.
 * The window stops two live processes from posting together; what stops a
 * reclaimed retry from posting twice is the channel-history read before it
 * posts (runWrappedAnnounce), since a send that timed out can still land.
 */
export const WRAPPED_RECLAIM_AFTER_MS = 30 * 60 * 1000;

/**
 * 'fresh': this caller inserted the year's row. 'retry': it took over an
 * unposted claim (crashed or released); the notice may already be in the
 * channel. false: posted, someone else holds a live claim, or the row is
 * backing off after a failed post (unless ignoreBackoff).
 */
export type WrappedClaim = 'fresh' | 'retry' | false;

export interface WrappedClaimOptions {
  reclaimAfterMs?: number;
  /** Post now: a released row is retried at once instead of after its backoff. */
  ignoreBackoff?: boolean;
}

export interface WrappedAnnouncementRecord {
  year: number;
  claimedAt: Date;
  /** Set once the post landed; final. */
  postedAt: Date | undefined;
  channelId: string | undefined;
  /** Unknown when a retry found the notice already in the channel. */
  messageId: string | undefined;
}

/**
 * One row per Wrapped year: the "your Wrapped is ready" notice's claim before
 * posting (so two processes, or the job and the Post now button, cannot both
 * post), the post once it landed (final), and reclaim of a claim that crashed
 * or failed. The same shape as PostgresDashboardNoticeRepository, keyed by
 * year, recording where the post went, with a retry_after for the backoff
 * after a failed post.
 */
export class PostgresWrappedAnnouncementRepository {
  private static singleton:
    Promise<PostgresWrappedAnnouncementRepository> | undefined;

  /** claimed_at (Postgres text, microseconds intact) of each claim this instance holds. */
  private readonly claimed = new Map<number, string>();

  constructor(private readonly pool: pg.Pool) {}

  static instance(): Promise<PostgresWrappedAnnouncementRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(
        (pool) => new PostgresWrappedAnnouncementRepository(pool),
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

  /**
   * See WrappedClaim. Staleness and the backoff use the database clock, so
   * two dynos agree. Two concurrent reclaims: the second re-checks the WHERE
   * against the first's new claimed_at and gets no row.
   */
  async claim(
    year: number,
    options: WrappedClaimOptions = {},
  ): Promise<WrappedClaim> {
    const result = await this.pool.query<{
      claimed_at: string;
      fresh: boolean;
    }>(
      `INSERT INTO wrapped_announcements AS w (year) VALUES ($1)
       ON CONFLICT (year) DO UPDATE SET claimed_at = now(), retry_after = NULL
         WHERE w.posted_at IS NULL
           AND w.claimed_at < now() - make_interval(secs => $2::double precision / 1000)
           AND ($3::boolean OR w.retry_after IS NULL OR w.retry_after <= now())
       RETURNING claimed_at::text AS claimed_at, (xmax = 0) AS fresh`,
      [
        year,
        options.reclaimAfterMs ?? WRAPPED_RECLAIM_AFTER_MS,
        options.ignoreBackoff === true,
      ],
    );
    if (result.rowCount !== 1) {
      return false;
    }
    this.claimed.set(year, result.rows[0].claimed_at);
    return result.rows[0].fresh ? 'fresh' : 'retry';
  }

  /** Records the post for this instance's own claim. False when the claim is gone (reclaimed). */
  async markPosted(
    year: number,
    post: { channelId: string; messageId: string | undefined },
  ): Promise<boolean> {
    const claimedAt = this.claimed.get(year);
    if (claimedAt === undefined) {
      return false;
    }
    const result = await this.pool.query(
      `UPDATE wrapped_announcements
          SET posted_at = now(), channel_id = $3, message_id = $4
        WHERE year = $1 AND claimed_at = $2::timestamptz AND posted_at IS NULL`,
      [year, claimedAt, post.channelId, post.messageId ?? null],
    );
    this.claimed.delete(year);
    return result.rowCount === 1;
  }

  /**
   * A failed post: this instance's unposted claim becomes retryable, after
   * retryAfterMs (the job's backoff; Post now ignores it) or at once.
   */
  async release(year: number, retryAfterMs = 0): Promise<void> {
    const claimedAt = this.claimed.get(year);
    if (claimedAt === undefined) {
      return;
    }
    await this.pool.query(
      `UPDATE wrapped_announcements
          SET claimed_at = '-infinity',
              retry_after = now() + make_interval(secs => $3::double precision / 1000)
        WHERE year = $1 AND claimed_at = $2::timestamptz AND posted_at IS NULL`,
      [year, claimedAt, retryAfterMs],
    );
    this.claimed.delete(year);
  }

  async get(year: number): Promise<WrappedAnnouncementRecord | undefined> {
    const result = await this.pool.query<{
      year: number;
      claimed_at: Date;
      posted_at: Date | null;
      channel_id: string | null;
      message_id: string | null;
    }>(
      `SELECT year, claimed_at, posted_at, channel_id, message_id
         FROM wrapped_announcements WHERE year = $1`,
      [year],
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return {
      year: row.year,
      claimedAt: row.claimed_at,
      postedAt: row.posted_at ?? undefined,
      channelId: row.channel_id ?? undefined,
      messageId: row.message_id ?? undefined,
    };
  }
}

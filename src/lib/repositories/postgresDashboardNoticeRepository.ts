import pg from 'pg';

import { Period, periodDate, periodKey } from '../reports/period.js';
import { dashboardPool } from './dashboardPool.js';

export type NoticeKind = 'report_ready';

function markerKey(kind: NoticeKind, period: Period): string {
  return `${kind}:${periodKey(period)}`;
}

/** An unposted claim older than this is taken to be a crash and is reclaimed. */
export const NOTICE_RECLAIM_AFTER_MS = 30 * 60 * 1000;

/**
 * 'fresh': this caller inserted the marker. 'retry': it took over an unposted
 * claim (crashed or released); the notice may already be in the channel.
 * false: posted, or someone else holds a live claim.
 */
export type NoticeClaim = 'fresh' | 'retry' | false;

/**
 * Durable report-ready markers: a claim before posting (so two processes
 * cannot both post), a post time once it landed (final), and reclaim of a
 * claim that crashed or failed (so a month is never left unannounced).
 */
export class PostgresDashboardNoticeRepository {
  private static singleton:
    Promise<PostgresDashboardNoticeRepository> | undefined;

  /**
   * claimed_at (as Postgres text, microseconds intact) of each claim this
   * instance holds, keyed by kind and month: markPosted and release touch
   * only those.
   */
  private readonly claimed = new Map<string, string>();

  constructor(private readonly pool: pg.Pool) {}

  static instance(): Promise<PostgresDashboardNoticeRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(
        (pool) => new PostgresDashboardNoticeRepository(pool),
      );
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
   * 'fresh': this caller inserted the marker. 'retry': it took over an
   * unposted claim that crashed (older than reclaimAfterMs) or whose post
   * failed (released); the notice may already be in the channel. false:
   * posted, or someone else holds a live claim. Staleness uses the database
   * clock, so two dynos agree. Two concurrent reclaims: the second re-checks
   * the WHERE against the first's new claimed_at and gets no row.
   */
  async claim(
    kind: NoticeKind,
    period: Period,
    reclaimAfterMs = NOTICE_RECLAIM_AFTER_MS,
  ): Promise<NoticeClaim> {
    const result = await this.pool.query<{
      claimed_at: string;
      fresh: boolean;
    }>(
      `INSERT INTO dashboard_notices AS n (kind, period) VALUES ($1, $2::date)
       ON CONFLICT (kind, period) DO UPDATE SET claimed_at = now()
         WHERE n.posted_at IS NULL
           AND n.claimed_at < now() - make_interval(secs => $3::double precision / 1000)
       RETURNING claimed_at::text AS claimed_at, (xmax = 0) AS fresh`,
      [kind, periodDate(period), reclaimAfterMs],
    );
    if (result.rowCount !== 1) {
      return false;
    }
    this.claimed.set(markerKey(kind, period), result.rows[0].claimed_at);
    return result.rows[0].fresh ? 'fresh' : 'retry';
  }

  /** Records the post for this instance's own claim. False when the claim is gone (reclaimed). */
  async markPosted(kind: NoticeKind, period: Period): Promise<boolean> {
    const key = markerKey(kind, period);
    const claimedAt = this.claimed.get(key);
    if (claimedAt === undefined) {
      return false;
    }
    const result = await this.pool.query(
      `UPDATE dashboard_notices SET posted_at = now()
        WHERE kind = $1 AND period = $2::date AND claimed_at = $3::timestamptz AND posted_at IS NULL`,
      [kind, periodDate(period), claimedAt],
    );
    this.claimed.delete(key);
    return result.rowCount === 1;
  }

  /** A failed post: this instance's unposted claim becomes retryable at once. Anyone else's is untouched. */
  async release(kind: NoticeKind, period: Period): Promise<void> {
    const key = markerKey(kind, period);
    const claimedAt = this.claimed.get(key);
    if (claimedAt === undefined) {
      return;
    }
    await this.pool.query(
      `UPDATE dashboard_notices SET claimed_at = '-infinity'
        WHERE kind = $1 AND period = $2::date AND claimed_at = $3::timestamptz AND posted_at IS NULL`,
      [kind, periodDate(period), claimedAt],
    );
    this.claimed.delete(key);
  }

  async isPosted(kind: NoticeKind, period: Period): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM dashboard_notices WHERE kind = $1 AND period = $2::date AND posted_at IS NOT NULL',
      [kind, periodDate(period)],
    );
    return result.rowCount === 1;
  }
}

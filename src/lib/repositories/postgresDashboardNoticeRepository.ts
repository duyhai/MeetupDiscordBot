import pg from 'pg';

import { Period, periodDate, periodKey } from '../reports/period.js';
import { dashboardPool } from './dashboardPool.js';

export type NoticeKind = 'report_ready';

function markerKey(kind: NoticeKind, period: Period): string {
  return `${kind}:${periodKey(period)}`;
}

/**
 * Durable "notice already posted" markers: a restart cannot post the same
 * notice twice, and a failed post releases its marker so the next tick retries.
 */
export class PostgresDashboardNoticeRepository {
  private static singleton:
    Promise<PostgresDashboardNoticeRepository> | undefined;

  /**
   * posted_at (as Postgres text, microseconds intact) of each marker this
   * instance inserted, keyed by kind and month: release deletes only those.
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

  /** Inserts the marker; true only for the caller that inserted it. */
  async claim(kind: NoticeKind, period: Period): Promise<boolean> {
    const result = await this.pool.query<{ posted_at: string }>(
      `INSERT INTO dashboard_notices (kind, period) VALUES ($1, $2::date)
       ON CONFLICT (kind, period) DO NOTHING RETURNING posted_at::text AS posted_at`,
      [kind, periodDate(period)],
    );
    if (result.rowCount !== 1) {
      return false;
    }
    this.claimed.set(markerKey(kind, period), result.rows[0].posted_at);
    return true;
  }

  /**
   * Deletes the marker this instance's own claim inserted (a failed post), so
   * the next tick retries. A caller that did not win the claim, or a stale
   * release after a newer claim, deletes nothing.
   */
  async release(kind: NoticeKind, period: Period): Promise<void> {
    const key = markerKey(kind, period);
    const postedAt = this.claimed.get(key);
    if (postedAt === undefined) {
      return;
    }
    await this.pool.query(
      `DELETE FROM dashboard_notices
       WHERE kind = $1 AND period = $2::date AND posted_at = $3::timestamptz`,
      [kind, periodDate(period), postedAt],
    );
    this.claimed.delete(key);
  }

  async has(kind: NoticeKind, period: Period): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM dashboard_notices WHERE kind = $1 AND period = $2::date',
      [kind, periodDate(period)],
    );
    return result.rowCount === 1;
  }
}

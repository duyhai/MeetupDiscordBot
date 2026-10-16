import pg from 'pg';

import { Period, periodDate } from '../reports/period.js';
import { dashboardPool } from './dashboardPool.js';

export type NoticeKind = 'report_ready';

/**
 * Durable "notice already posted" markers: a restart cannot post the same
 * notice twice, and a failed post releases its marker so the next tick retries.
 */
export class PostgresDashboardNoticeRepository {
  private static singleton:
    Promise<PostgresDashboardNoticeRepository> | undefined;

  constructor(private readonly pool: pg.Pool) {}

  static instance(): Promise<PostgresDashboardNoticeRepository> {
    if (this.singleton === undefined) {
      this.singleton = dashboardPool().then(
        (pool) => new PostgresDashboardNoticeRepository(pool),
      );
      // A failed schema ensure is retried on the next call.
      this.singleton.catch(() => {
        this.singleton = undefined;
      });
    }
    return this.singleton;
  }

  /** Inserts the marker; true only for the caller that inserted it. */
  async claim(kind: NoticeKind, period: Period): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO dashboard_notices (kind, period) VALUES ($1, $2::date)
       ON CONFLICT (kind, period) DO NOTHING RETURNING kind`,
      [kind, periodDate(period)],
    );
    return result.rowCount === 1;
  }

  /** Deletes the marker (a failed post), so the next tick retries. */
  async release(kind: NoticeKind, period: Period): Promise<void> {
    await this.pool.query(
      'DELETE FROM dashboard_notices WHERE kind = $1 AND period = $2::date',
      [kind, periodDate(period)],
    );
  }

  async has(kind: NoticeKind, period: Period): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM dashboard_notices WHERE kind = $1 AND period = $2::date',
      [kind, periodDate(period)],
    );
    return result.rowCount === 1;
  }
}

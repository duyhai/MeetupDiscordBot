import pg from 'pg';

import { LinkProgressCounts } from '../reports/linkProgress.js';
import { dashboardPool } from './dashboardPool.js';

export interface LinkProgressDay extends LinkProgressCounts {
  /** 'YYYY-MM-DD' */
  day: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 90;
const MAX_LIMIT = 1000;

interface DayRow {
  day_key: string;
  linked: number;
  unlinked: number;
  reverify_tagged: number;
  onboarding: number;
}

export class PostgresLinkProgressRepository {
  private static singleton: Promise<PostgresLinkProgressRepository> | undefined;

  constructor(private readonly pool: pg.Pool) {}

  static instance(): Promise<PostgresLinkProgressRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(
        (pool) => new PostgresLinkProgressRepository(pool),
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

  async upsertDay(day: string, counts: LinkProgressCounts): Promise<void> {
    if (!DAY.test(day)) {
      throw new RangeError('day must be YYYY-MM-DD');
    }
    await this.pool.query(
      `INSERT INTO link_progress_daily (day, linked, unlinked, reverify_tagged, onboarding)
       VALUES ($1::date, $2, $3, $4, $5)
       ON CONFLICT (day) DO UPDATE SET linked = EXCLUDED.linked, unlinked = EXCLUDED.unlinked,
         reverify_tagged = EXCLUDED.reverify_tagged, onboarding = EXCLUDED.onboarding`,
      [
        day,
        counts.linked,
        counts.unlinked,
        counts.reverifyTagged,
        counts.onboarding,
      ],
    );
  }

  async hasDay(day: string): Promise<boolean> {
    if (!DAY.test(day)) {
      throw new RangeError('day must be YYYY-MM-DD');
    }
    const result = await this.pool.query(
      'SELECT 1 FROM link_progress_daily WHERE day = $1::date',
      [day],
    );
    return result.rowCount > 0;
  }

  /** Newest first. */
  async listDays(limit = DEFAULT_LIMIT): Promise<LinkProgressDay[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
    const result = await this.pool.query<DayRow>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day_key, linked, unlinked, reverify_tagged, onboarding
       FROM link_progress_daily ORDER BY day DESC LIMIT $1`,
      [bounded],
    );
    return result.rows.map((r) => ({
      day: r.day_key,
      linked: r.linked,
      unlinked: r.unlinked,
      reverifyTagged: r.reverify_tagged,
      onboarding: r.onboarding,
    }));
  }
}

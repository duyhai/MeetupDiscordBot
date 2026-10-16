import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Period } from '../../src/lib/reports/period.js';
import { ensureDashboardSchema } from '../../src/lib/repositories/dashboardPool.js';
import { PostgresDashboardNoticeRepository } from '../../src/lib/repositories/postgresDashboardNoticeRepository.js';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresDashboardNoticeRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const SEPTEMBER: Period = { year: 2026, month: 9 };
const AUGUST: Period = { year: 2026, month: 8 };

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresDashboardNoticeRepository',
  () => {
    let pool: pg.Pool;
    let repo: PostgresDashboardNoticeRepository;

    beforeAll(async () => {
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 6,
      });
      await ensureDashboardSchema(pool);
      repo = new PostgresDashboardNoticeRepository(pool);
    });

    beforeEach(async () => {
      await pool.query('TRUNCATE dashboard_notices');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('claim succeeds once per kind and period', async () => {
      expect(await repo.has('report_ready', SEPTEMBER)).toBe(false);
      expect(await repo.claim('report_ready', SEPTEMBER)).toBe(true);
      expect(await repo.claim('report_ready', SEPTEMBER)).toBe(false);
      expect(await repo.has('report_ready', SEPTEMBER)).toBe(true);
      expect(await repo.claim('report_ready', AUGUST)).toBe(true);
      const stored = await pool.query<{ period_key: string }>(
        `SELECT to_char(period, 'YYYY-MM-DD') AS period_key
         FROM dashboard_notices ORDER BY period`,
      );
      expect(stored.rows.map((r) => r.period_key)).toEqual([
        '2026-08-01',
        '2026-09-01',
      ]);
    });

    it('release lets the next claim succeed', async () => {
      expect(await repo.claim('report_ready', SEPTEMBER)).toBe(true);
      await repo.release('report_ready', SEPTEMBER);
      expect(await repo.has('report_ready', SEPTEMBER)).toBe(false);
      expect(await repo.claim('report_ready', SEPTEMBER)).toBe(true);
      // Releasing an absent marker is a no-op and leaves other months alone.
      await repo.release('report_ready', AUGUST);
      expect(await repo.has('report_ready', SEPTEMBER)).toBe(true);
    });

    it('a release from a caller that lost the claim leaves the winner marker', async () => {
      const winner = new PostgresDashboardNoticeRepository(pool);
      const loser = new PostgresDashboardNoticeRepository(pool);
      expect(await winner.claim('report_ready', SEPTEMBER)).toBe(true);
      expect(await loser.claim('report_ready', SEPTEMBER)).toBe(false);
      await loser.release('report_ready', SEPTEMBER);
      expect(await winner.has('report_ready', SEPTEMBER)).toBe(true);
      // The winner's own release still works.
      await winner.release('report_ready', SEPTEMBER);
      expect(await winner.has('report_ready', SEPTEMBER)).toBe(false);
    });

    it('a stale release after someone else re-claimed deletes nothing', async () => {
      const first = new PostgresDashboardNoticeRepository(pool);
      const second = new PostgresDashboardNoticeRepository(pool);
      expect(await first.claim('report_ready', SEPTEMBER)).toBe(true);
      // The marker goes away by other means (an operator, or the first
      // holder's release racing), and another process claims again.
      await pool.query('DELETE FROM dashboard_notices');
      expect(await second.claim('report_ready', SEPTEMBER)).toBe(true);
      await first.release('report_ready', SEPTEMBER);
      expect(await second.has('report_ready', SEPTEMBER)).toBe(true);
    });

    it('concurrent claims: exactly one wins', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => repo.claim('report_ready', SEPTEMBER)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const count = await pool.query<{ n: string }>(
        'SELECT COUNT(*) AS n FROM dashboard_notices',
      );
      expect(Number(count.rows[0].n)).toBe(1);
    });
  },
);

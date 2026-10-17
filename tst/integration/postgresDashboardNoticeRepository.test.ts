import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Period } from '../../src/lib/reports/period.js';
import {
  DASHBOARD_LOCK_CLASS,
  DASHBOARD_SCHEMA_SQL,
  ensureDashboardSchema,
  SCHEMA_LOCK_KEY,
} from '../../src/lib/repositories/dashboardPool.js';
import { PostgresDashboardNoticeRepository } from '../../src/lib/repositories/postgresDashboardNoticeRepository.js';
import { useIsolatedSchema } from './isolatedSchema.js';

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

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresDashboardNoticeRepository',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let repo: PostgresDashboardNoticeRepository;
    const another = () => new PostgresDashboardNoticeRepository(pool);

    beforeAll(async () => {
      schema = await useIsolatedSchema('notices');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 6,
      });
    });

    beforeEach(async () => {
      await pool.query('DROP TABLE IF EXISTS dashboard_notices');
      await ensureDashboardSchema(pool);
      repo = another();
    });

    afterAll(async () => {
      await pool.end();
      await schema.drop();
    });

    it('claim is fresh once per kind and period', async () => {
      expect(await repo.isPosted('report_ready', SEPTEMBER)).toBe(false);
      expect(await repo.claim('report_ready', SEPTEMBER)).toBe('fresh');
      expect(await repo.claim('report_ready', SEPTEMBER)).toBe(false);
      expect(await another().claim('report_ready', SEPTEMBER)).toBe(false);
      expect(await repo.isPosted('report_ready', SEPTEMBER)).toBe(false);
      expect(await repo.claim('report_ready', AUGUST)).toBe('fresh');
      const stored = await pool.query<{ period_key: string }>(
        `SELECT to_char(period, 'YYYY-MM-DD') AS period_key
         FROM dashboard_notices ORDER BY period`,
      );
      expect(stored.rows.map((r) => r.period_key)).toEqual([
        '2026-08-01',
        '2026-09-01',
      ]);
    });

    it('a posted marker is never reclaimed', async () => {
      expect(await repo.claim('report_ready', SEPTEMBER)).toBe('fresh');
      expect(await repo.markPosted('report_ready', SEPTEMBER)).toBe(true);
      expect(await repo.isPosted('report_ready', SEPTEMBER)).toBe(true);
      await pause(20);
      expect(await another().claim('report_ready', SEPTEMBER, 0)).toBe(false);
      // A release after the post changes nothing either.
      await repo.release('report_ready', SEPTEMBER);
      expect(await another().claim('report_ready', SEPTEMBER, 0)).toBe(false);
      expect(await repo.isPosted('report_ready', SEPTEMBER)).toBe(true);
    });

    it('an unposted claim is reclaimed as a retry after the reclaim window', async () => {
      expect(await repo.claim('report_ready', SEPTEMBER)).toBe('fresh');
      expect(await another().claim('report_ready', SEPTEMBER, 60_000)).toBe(
        false,
      );
      await pause(50);
      expect(await another().claim('report_ready', SEPTEMBER, 10)).toBe(
        'retry',
      );
      expect(await repo.isPosted('report_ready', SEPTEMBER)).toBe(false);
    });

    it('release makes the claim retryable at once', async () => {
      expect(await repo.claim('report_ready', SEPTEMBER)).toBe('fresh');
      await repo.release('report_ready', SEPTEMBER);
      expect(await repo.isPosted('report_ready', SEPTEMBER)).toBe(false);
      expect(await another().claim('report_ready', SEPTEMBER)).toBe('retry');
      // Releasing an absent marker is a no-op and leaves other months alone.
      await repo.release('report_ready', AUGUST);
      const count = await pool.query<{ n: string }>(
        'SELECT COUNT(*) AS n FROM dashboard_notices',
      );
      expect(Number(count.rows[0].n)).toBe(1);
    });

    it('a release from a caller that lost the claim changes nothing', async () => {
      const winner = another();
      const loser = another();
      expect(await winner.claim('report_ready', SEPTEMBER)).toBe('fresh');
      expect(await loser.claim('report_ready', SEPTEMBER)).toBe(false);
      await loser.release('report_ready', SEPTEMBER);
      // Still a live claim: nobody else can take it inside the window.
      expect(await another().claim('report_ready', SEPTEMBER)).toBe(false);
      expect(await winner.markPosted('report_ready', SEPTEMBER)).toBe(true);
    });

    it('a stale release after someone else reclaimed changes nothing', async () => {
      const first = another();
      const second = another();
      expect(await first.claim('report_ready', SEPTEMBER)).toBe('fresh');
      await pause(20);
      expect(await second.claim('report_ready', SEPTEMBER, 0)).toBe('retry');
      await first.release('report_ready', SEPTEMBER);
      // second's claim is still live, so a default-window claim gets nothing.
      expect(await another().claim('report_ready', SEPTEMBER)).toBe(false);
      expect(await second.markPosted('report_ready', SEPTEMBER)).toBe(true);
    });

    it("markPosted marks only the caller's own claim", async () => {
      const a = another();
      const b = another();
      expect(await a.claim('report_ready', SEPTEMBER)).toBe('fresh');
      expect(await b.markPosted('report_ready', SEPTEMBER)).toBe(false);
      expect(await a.isPosted('report_ready', SEPTEMBER)).toBe(false);
      expect(await a.markPosted('report_ready', SEPTEMBER)).toBe(true);
      expect(await b.isPosted('report_ready', SEPTEMBER)).toBe(true);
    });

    it("a reclaimed claim makes the old owner's markPosted fail", async () => {
      const a = another();
      const b = another();
      expect(await a.claim('report_ready', SEPTEMBER)).toBe('fresh');
      await pause(20);
      expect(await b.claim('report_ready', SEPTEMBER, 0)).toBe('retry');
      expect(await a.markPosted('report_ready', SEPTEMBER)).toBe(false);
      expect(await a.isPosted('report_ready', SEPTEMBER)).toBe(false);
      expect(await b.markPosted('report_ready', SEPTEMBER)).toBe(true);
      expect(await a.isPosted('report_ready', SEPTEMBER)).toBe(true);
    });

    it('concurrent fresh claims: exactly one wins', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          another().claim('report_ready', SEPTEMBER),
        ),
      );
      expect(results.filter((r) => r !== false)).toEqual(['fresh']);
      const count = await pool.query<{ n: string }>(
        'SELECT COUNT(*) AS n FROM dashboard_notices',
      );
      expect(Number(count.rows[0].n)).toBe(1);
    });

    it('concurrent reclaims: exactly one wins', async () => {
      expect(await repo.claim('report_ready', SEPTEMBER)).toBe('fresh');
      await repo.release('report_ready', SEPTEMBER);
      // The default window: the released (-infinity) claim is stale, the
      // winner's new one is not. (With a 0 ms window every waiter's re-check
      // sees an older claim than its own now(), so each may take it in turn.)
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          another().claim('report_ready', SEPTEMBER),
        ),
      );
      expect(results.filter((r) => r !== false)).toEqual(['retry']);
    });

    it('upgrades a PR 2 table: old markers count as posted', async () => {
      await pool.query('DROP TABLE dashboard_notices');
      await pool.query(`CREATE TABLE dashboard_notices (
        kind      TEXT NOT NULL CHECK (kind IN ('report_ready')),
        period    DATE NOT NULL CHECK (EXTRACT(DAY FROM period) = 1),
        posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (kind, period)
      )`);
      await pool.query(
        "INSERT INTO dashboard_notices (kind, period) VALUES ('report_ready', '2026-09-01')",
      );
      await ensureDashboardSchema(pool);

      expect(await repo.isPosted('report_ready', SEPTEMBER)).toBe(true);
      expect(await repo.claim('report_ready', SEPTEMBER, 0)).toBe(false);
      const columns = await pool.query<{
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'dashboard_notices'
          ORDER BY column_name`,
      );
      const byName = new Map(columns.rows.map((c) => [c.column_name, c]));
      expect(byName.get('posted_at')?.is_nullable).toBe('YES');
      expect(byName.get('posted_at')?.column_default).toBeNull();
      expect(byName.get('claimed_at')?.is_nullable).toBe('NO');
      expect(byName.get('claimed_at')?.column_default).toBe('now()');
      // A new month on the upgraded table works like a new table.
      expect(await repo.claim('report_ready', AUGUST)).toBe('fresh');
      expect(await repo.isPosted('report_ready', AUGUST)).toBe(false);
    });

    /**
     * The locks the schema statements take on dashboard_notices, read from
     * pg_locks inside the same transaction ensureDashboardSchema runs (lock
     * then DASHBOARD_SCHEMA_SQL), then rolled back.
     */
    async function noticeLocksDuringSchema(): Promise<string[]> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
          DASHBOARD_LOCK_CLASS,
          SCHEMA_LOCK_KEY,
        ]);
        await client.query(DASHBOARD_SCHEMA_SQL);
        const locks = await client.query<{ mode: string }>(
          `SELECT mode FROM pg_locks
            WHERE pid = pg_backend_pid()
              AND relation = to_regclass(quote_ident(current_schema()) || '.dashboard_notices')
            ORDER BY mode`,
        );
        return locks.rows.map((r) => r.mode);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }

    it('a boot on an upgraded table takes no AccessExclusiveLock on dashboard_notices', async () => {
      // beforeEach already ran the schema once (a fresh table); a PR 2 table
      // upgraded by one boot must be the same on the next.
      expect(await noticeLocksDuringSchema()).not.toContain(
        'AccessExclusiveLock',
      );
      await pool.query('DROP TABLE dashboard_notices');
      await pool.query(`CREATE TABLE dashboard_notices (
        kind      TEXT NOT NULL CHECK (kind IN ('report_ready')),
        period    DATE NOT NULL CHECK (EXTRACT(DAY FROM period) = 1),
        posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (kind, period)
      )`);
      // The upgrade itself does lock: the measurement is not vacuous.
      expect(await noticeLocksDuringSchema()).toContain('AccessExclusiveLock');
      await ensureDashboardSchema(pool);
      expect(await noticeLocksDuringSchema()).not.toContain(
        'AccessExclusiveLock',
      );
    });

    it('schema is idempotent', async () => {
      expect(await repo.claim('report_ready', SEPTEMBER)).toBe('fresh');
      expect(await repo.markPosted('report_ready', SEPTEMBER)).toBe(true);
      expect(await repo.claim('report_ready', AUGUST)).toBe('fresh');
      await ensureDashboardSchema(pool);
      await ensureDashboardSchema(pool);
      expect(await repo.isPosted('report_ready', SEPTEMBER)).toBe(true);
      expect(await repo.isPosted('report_ready', AUGUST)).toBe(false);
      // The unposted August claim keeps its claim time: still not reclaimable.
      expect(await another().claim('report_ready', AUGUST)).toBe(false);
    });
  },
);

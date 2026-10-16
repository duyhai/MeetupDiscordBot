import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureDashboardSchema } from '../../src/lib/repositories/dashboardPool.js';
import { PostgresLinkProgressRepository } from '../../src/lib/repositories/postgresLinkProgressRepository.js';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresLinkProgressRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresLinkProgressRepository',
  () => {
    let pool: pg.Pool;
    let repo: PostgresLinkProgressRepository;

    beforeAll(async () => {
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 3,
      });
      await ensureDashboardSchema(pool);
      repo = new PostgresLinkProgressRepository(pool);
    });

    beforeEach(async () => {
      await pool.query('TRUNCATE link_progress_daily');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('upsert is idempotent per day', async () => {
      await repo.upsertDay('2026-10-05', {
        linked: 1,
        unlinked: 2,
        reverifyTagged: 3,
        onboarding: 4,
      });
      await repo.upsertDay('2026-10-05', {
        linked: 10,
        unlinked: 20,
        reverifyTagged: 30,
        onboarding: 40,
      });
      expect(await repo.listDays()).toEqual([
        {
          day: '2026-10-05',
          linked: 10,
          unlinked: 20,
          reverifyTagged: 30,
          onboarding: 40,
        },
      ]);
      expect(await repo.hasDay('2026-10-05')).toBe(true);
      expect(await repo.hasDay('2026-10-06')).toBe(false);
    });

    it('listDays returns day strings, newest first', async () => {
      const counts = {
        linked: 1,
        unlinked: 1,
        reverifyTagged: 0,
        onboarding: 0,
      };
      await repo.upsertDay('2026-10-04', counts);
      await repo.upsertDay('2026-10-06', counts);
      await repo.upsertDay('2026-10-05', counts);
      const days = await repo.listDays();
      expect(days.map((d) => d.day)).toEqual([
        '2026-10-06',
        '2026-10-05',
        '2026-10-04',
      ]);
      expect((await repo.listDays(2)).map((d) => d.day)).toEqual([
        '2026-10-06',
        '2026-10-05',
      ]);
    });

    it('rejects a malformed day', async () => {
      await expect(
        repo.upsertDay('2026-10-5', {
          linked: 0,
          unlinked: 0,
          reverifyTagged: 0,
          onboarding: 0,
        }),
      ).rejects.toThrow(RangeError);
    });
  },
);

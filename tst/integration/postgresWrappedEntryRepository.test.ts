import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureDashboardSchema } from '../../src/lib/repositories/dashboardPool.js';
import { PostgresWrappedEntryRepository } from '../../src/lib/repositories/postgresWrappedEntryRepository.js';
import { CachedWrapped } from '../../src/lib/wrapped/cache.js';
import { useIsolatedSchema } from './isolatedSchema.js';

const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresWrappedEntryRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const A = '100000000000000001';
const NOW = new Date('2026-12-10T20:00:00Z');

const copy = (year: number, meetupId = 'm1'): CachedWrapped => ({
  meetupId,
  stats: {
    year,
    firstEvent: null,
    attendedThisYear: 2,
    attendedAllTime: 5,
    topTypes: [],
    hosting: null,
    busiestMonth: null,
    longestStreakMonths: 0,
    activeYears: [year],
  },
  companions: {
    named: [{ discordUserId: '200000000000000001', sharedCount: 1 }],
    otherCount: 2,
  },
  builtAt: NOW.toISOString(),
});

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresWrappedEntryRepository',
  () => {
    let schema: { drop(): Promise<void> };
    let pool: pg.Pool;
    let repo: PostgresWrappedEntryRepository;

    beforeAll(async () => {
      schema = await useIsolatedSchema('wrapped_entries');
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 4,
      });
    });

    beforeEach(async () => {
      await pool.query('DROP TABLE IF EXISTS wrapped_entries');
      await ensureDashboardSchema(pool);
      repo = new PostgresWrappedEntryRepository(pool);
    });

    afterAll(async () => {
      await pool.end();
      await schema.drop();
    });

    it('round-trips an entry and replaces it on a second put', async () => {
      await repo.put(A, 2026, copy(2026), NOW);
      expect(await repo.get(A, 2026)).toEqual(copy(2026));
      const newer = { ...copy(2026), builtAt: '2026-12-11T20:00:00.000Z' };
      await repo.put(A, 2026, newer, new Date('2026-12-11T20:00:00Z'));
      expect(await repo.get(A, 2026)).toEqual(newer);
      expect(await repo.count()).toBe(1);
    });

    it('a put for the current link deletes the member’s rows for another account', async () => {
      await repo.put(A, 2024, copy(2024, 'old'), NOW);
      await repo.put(A, 2025, copy(2025, 'old'), NOW);
      await repo.put(A, 2026, copy(2026, 'm1'), NOW);
      expect(await repo.get(A, 2024)).toBeUndefined();
      expect(await repo.get(A, 2025)).toBeUndefined();
      expect((await repo.get(A, 2026))?.meetupId).toBe('m1');
      expect(await repo.count()).toBe(1);
    });

    it('the schema is idempotent on a second boot', async () => {
      await ensureDashboardSchema(pool);
      expect(await repo.get(A, 2026)).toBeUndefined();
    });
  },
);

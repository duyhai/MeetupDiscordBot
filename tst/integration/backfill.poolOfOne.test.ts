import nock from 'nock';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { FakeCache } from '../web/fakeCache.js';
import { installMeetupResponder } from '../fixtures/meetup/graphqlResponder.js';
import { WORLD_2026 } from '../fixtures/meetup/world2026.js';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping the backfill pool-of-one integration test: set DATABASE_URL to a reachable Postgres to run it.',
  );
}

/** The backfill dyno's pools, created fresh in this file with PG_POOL_MAX=1. */
async function poolsOfOne() {
  vi.resetModules();
  process.env.PG_POOL_MAX = '1';
  const [snapshotsModule, suspensionsModule, dashboardModule] =
    await Promise.all([
      import('../../src/lib/repositories/postgresReportSnapshotRepository.js'),
      import('../../src/lib/repositories/postgresSuspensionRepository.js'),
      import('../../src/lib/repositories/dashboardPool.js'),
    ]);
  const snapshots =
    await snapshotsModule.PostgresReportSnapshotRepository.instance();
  const suspensions =
    await suspensionsModule.PostgresSuspensionRepository.instance();
  const dashboard = await dashboardModule.dashboardPool();
  return { snapshots, suspensions, dashboard };
}

describe.skipIf(!POSTGRES_AVAILABLE)('backfill with PG_POOL_MAX=1', () => {
  const saved = process.env.PG_POOL_MAX;
  /** The pools this file created, ended so the worker exits cleanly. */
  const pools: { end(): Promise<void> }[] = [];

  afterAll(async () => {
    nock.cleanAll();
    await Promise.all(pools.map((pool) => pool.end()));
    if (saved === undefined) {
      delete process.env.PG_POOL_MAX;
    } else {
      process.env.PG_POOL_MAX = saved;
    }
  });

  it('builds and saves one month through the real build path without a deadlock', async () => {
    const { snapshots, suspensions, dashboard } = await poolsOfOne();
    const suspensionPool = (
      suspensions as unknown as {
        pool: { options: { max: number }; end(): Promise<void> };
      }
    ).pool;
    pools.push(dashboard, suspensionPool);
    expect(dashboard.options.max).toBe(1);
    expect(suspensionPool.options.max).toBe(1);

    const [{ runBackfill }, { organizerMonthReports }, { GqlMeetupClient }] =
      await Promise.all([
        import('../../src/lib/reports/backfill.js'),
        import('../../src/lib/reports/buildJob.js'),
        import('../../src/lib/client/meetup/gqlClient.js'),
      ]);
    // Fixture Meetup over nock; no Discord, no real token.
    const responder = installMeetupResponder(WORLD_2026);
    const saves: { id: number; builtBy: string }[] = [];
    const post = vi.fn(() => Promise.resolve(true));
    const now = () => new Date('2026-10-16T19:30:00Z');
    const result = await runBackfill(
      {
        now,
        cache: () => Promise.resolve(new FakeCache()),
        build: {
          now,
          snapshots: {
            getCurrentMeta: (type, period) =>
              snapshots.getCurrentMeta(type, period),
            // The ids come from Postgres itself (INSERT … RETURNING), so no
            // read-back can race another file's TRUNCATE.
            save: async (write) => {
              const meta = await snapshots.save(write);
              saves.push({ id: meta.id, builtBy: meta.builtBy });
              return meta;
            },
          },
          fetchMonthReports: organizerMonthReports(undefined, suspensions, {
            getToken: () => Promise.resolve('fixture-token'),
            makeClient: (token) =>
              new GqlMeetupClient(token, { bypassCache: true }),
          }),
        },
        post,
        sleep: () => Promise.resolve(),
        newLeaseValue: () => 'pool-of-one',
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      {
        // force: another file's rows for this month must not make it skip.
        force: true,
        from: { year: 2026, month: 9 },
        delayMs: 0,
        leaseWaitMs: 0,
        allowAllDeparted: false,
      },
    );
    expect(result.failed).toEqual([]);
    expect(result.stopped).toBeUndefined();
    expect(result.built).toEqual([{ year: 2026, month: 9 }]);
    expect(saves).toHaveLength(2);
    saves.forEach((s) => {
      expect(s.id).toBeGreaterThan(0);
      expect(s.builtBy).toBe('backfill');
    });
    expect(responder.unhandled()).toEqual([]);
    expect(post).toHaveBeenCalledTimes(2); // start and final
  });
});

import nock from 'nock';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import { buildMonth } from '../../../src/lib/reports/buildJob.js';
import { BUILD_LEASE_TTL_SEC } from '../../../src/lib/reports/buildLease.js';
import { buildMonthReports } from '../../../src/lib/reports/monthReports.js';
import { ApplicationCache } from '../../../src/util/cache.js';
import { fakeSuspensionRepository } from '../../fixtures/meetup/fakeSuspensions.js';
import { installMeetupResponder } from '../../fixtures/meetup/graphqlResponder.js';
import {
  SUSPENSIONS_2026,
  WORLD_2026,
} from '../../fixtures/meetup/world2026.js';
import { makeDeps } from './buildJobFakes.js';

// The job's client bypasses the request cache; fail loudly if anything reaches it.
vi.mock('../../../src/util/cache.js', () => ({
  ApplicationCache: vi.fn(() => {
    throw new Error('the build job must not use the request cache');
  }),
}));

afterEach(() => {
  nock.cleanAll();
});

// Not a performance assertion: it records how long one month takes against
// the Task 1 fixture so the number can go in the PR, next to the lease TTL.
describe('report build timing (fixture)', () => {
  it('builds September 2026 from the fixture responder', async () => {
    const responder = installMeetupResponder(WORLD_2026, { maxPageSize: 2 });
    const h = makeDeps();
    // The fake clock starts on 2026-10-05 16:15Z and advances in real time.
    const base = Date.parse('2026-10-05T16:15:00Z');
    const t0 = Date.now();
    h.deps.now = () => new Date(base + (Date.now() - t0));
    h.deps.fetchMonthReports = (period, asOf, cutoff) =>
      buildMonthReports(
        new GqlMeetupClient('timing-token', { bypassCache: true }),
        period,
        {
          asOf,
          suspensionCutoff: cutoff,
          groupId: WORLD_2026.groupId,
          suspensions: fakeSuspensionRepository(SUSPENSIONS_2026),
        },
      );

    const outcome = await buildMonth(h.deps, { year: 2026, month: 9 }, 'job');

    // eslint-disable-next-line no-console -- the number goes in the PR
    console.log(
      `[timing] fixture build of 2026-09: ${outcome.durationMs} ms, ` +
        `${responder.calls.length} Meetup calls (lease TTL ${BUILD_LEASE_TTL_SEC * 1000} ms)`,
    );
    expect(responder.unhandled()).toEqual([]);
    expect(responder.failures()).toEqual([]);
    expect(h.snapshots.rows).toHaveLength(2);
    expect(outcome.durationMs).toBeLessThan(BUILD_LEASE_TTL_SEC * 1000);
    expect(ApplicationCache).not.toHaveBeenCalled();
  });
});

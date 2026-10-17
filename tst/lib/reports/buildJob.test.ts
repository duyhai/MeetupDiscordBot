/* eslint-disable
  @typescript-eslint/unbound-method,
*/
import { Client } from 'discord.js';
import { ClientError } from 'graphql-request';
import { Logger } from 'tslog';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BOT_ALERTS_CHANNEL_ID } from '../../../src/constants.js';
import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import {
  logAlert,
  recentEmbedTitles,
} from '../../../src/lib/helpers/discordLogger.js';
import {
  buildMonth,
  buildSummaryEntry,
  defaultBuildJobDeps,
  DEPARTED_GUARD_MIN_MEMBERS,
  describeBuildError,
  maybePostReportReady,
  MembershipsUnreadableError,
  MonthBeforeGroupBuildError,
  MonthBuildDeps,
  REPORT_READY_ENABLED,
  reportReadyEntry,
  requestRebuild,
  runBuildTick,
  WORKSPACE_MALFORMED_META_DEADLINE_MS,
  WORKSPACE_SYNC_DEADLINE_MS,
} from '../../../src/lib/reports/buildJob.js';
import {
  planDueWork,
  snapshotKey,
} from '../../../src/lib/reports/buildSchedule.js';
import { collectLinkProgress } from '../../../src/lib/reports/linkProgress.js';
import { buildMonthReports } from '../../../src/lib/reports/monthReports.js';
import {
  defaultOrganizerMeetupDeps,
  OrganizerTokenUnavailableError,
  withOrganizerMeetup,
} from '../../../src/lib/reports/organizerMeetup.js';
import { Period, periodOf } from '../../../src/lib/reports/period.js';
import { REPORT_TYPES } from '../../../src/lib/reports/types.js';
import { PostgresDashboardNoticeRepository } from '../../../src/lib/repositories/postgresDashboardNoticeRepository.js';
import { PostgresLinkProgressRepository } from '../../../src/lib/repositories/postgresLinkProgressRepository.js';
import { PostgresNoShowWorkspaceRepository } from '../../../src/lib/repositories/postgresNoShowWorkspaceRepository.js';
import { PostgresReportSnapshotRepository } from '../../../src/lib/repositories/postgresReportSnapshotRepository.js';
import { PostgresSuspensionRepository } from '../../../src/lib/repositories/postgresSuspensionRepository.js';
import { ApplicationCache } from '../../../src/util/cache.js';
import { FakeCache } from '../../web/fakeCache.js';
import {
  Clock,
  ExpiringCache,
  FakeLinkProgressStore,
  FakeNoticeStore,
  FakeSnapshotStore,
  Harness,
  makeDeps,
  monthReports,
} from './buildJobFakes.js';

// Only defaultBuildJobDeps uses these; the runner tests inject fakes.
vi.mock(
  '../../../src/lib/reports/organizerMeetup.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../src/lib/reports/organizerMeetup.js')
      >();
    return { ...actual, withOrganizerMeetup: vi.fn() };
  },
);
vi.mock('../../../src/lib/reports/monthReports.js', () => ({
  buildMonthReports: vi.fn(),
}));
vi.mock('../../../src/lib/reports/linkProgress.js', () => ({
  collectLinkProgress: vi.fn(),
}));
vi.mock('../../../src/lib/helpers/discordLogger.js', () => ({
  logAlert: vi.fn(),
  recentEmbedTitles: vi.fn(),
}));
vi.mock(
  '../../../src/lib/repositories/postgresReportSnapshotRepository.js',
  () => ({ PostgresReportSnapshotRepository: { instance: vi.fn() } }),
);
vi.mock(
  '../../../src/lib/repositories/postgresDashboardNoticeRepository.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../src/lib/repositories/postgresDashboardNoticeRepository.js')
    >()),
    PostgresDashboardNoticeRepository: { instance: vi.fn() },
  }),
);
vi.mock(
  '../../../src/lib/repositories/postgresLinkProgressRepository.js',
  () => ({ PostgresLinkProgressRepository: { instance: vi.fn() } }),
);
vi.mock(
  '../../../src/lib/repositories/postgresSuspensionRepository.js',
  () => ({ PostgresSuspensionRepository: { instance: vi.fn() } }),
);
vi.mock(
  '../../../src/lib/repositories/postgresNoShowWorkspaceRepository.js',
  () => ({ PostgresNoShowWorkspaceRepository: { instance: vi.fn() } }),
);

const SEPT: Period = { year: 2026, month: 9 };
const OCT: Period = { year: 2026, month: 10 };
const LEASE_KEY = 'report-build-claim';
const REQUESTER = '123456789012345678';

const isSept = (p: Period) => p.year === 2026 && p.month === 9;
const ready = (h: Harness) =>
  h.alert.mock.calls
    .map(([e]) => e)
    .filter((e) => e.title.startsWith('Reports ready:'));
const titles = (alert: { mock: { calls: [{ title: string }][] } }) =>
  alert.mock.calls.map(([entry]) => entry.title);
const descriptions = (alert: {
  mock: { calls: [{ description?: string }][] };
}) => alert.mock.calls.map(([entry]) => entry.description ?? '');
const failSeptember = (period: Period) => {
  if (isSept(period)) {
    return Promise.reject(new Error('boom'));
  }
  return Promise.resolve(monthReports(period));
};
const fetchedPeriods = (h: ReturnType<typeof makeDeps>) =>
  h.fetchMonthReports.mock.calls.map(([p]) => `${p.year}-${p.month}`);

afterEach(() => {
  vi.clearAllMocks();
});

describe('runBuildTick guards', () => {
  it('never starts 18:00–19:00 UTC', async () => {
    const h = makeDeps({ clock: new Clock('2026-10-05T18:30:00Z') });
    await runBuildTick(h.deps);
    expect(h.cacheSpy).not.toHaveBeenCalled();
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
  });

  it('defers while the identity digest claim is held without its done marker', async () => {
    const h = makeDeps();
    const exclusiveSet = vi.spyOn(h.cache, 'exclusive_set');
    h.cache.values.set('identity-digest-2026-10-05', 'x');
    await runBuildTick(h.deps);
    expect(exclusiveSet).not.toHaveBeenCalled(); // no lease taken
    expect(h.fetchMonthReports).not.toHaveBeenCalled();

    h.cache.values.set('identity-digest-done-2026-10-05', 'x');
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h)).toEqual(['2026-9', '2026-10']);

    // A digest that starts mid-tick stops new months from starting.
    const h2 = makeDeps();
    h2.fetchMonthReports.mockImplementationOnce((period) => {
      h2.cache.values.set('identity-digest-2026-10-05', 'x');
      return Promise.resolve(monthReports(period));
    });
    await runBuildTick(h2.deps);
    expect(fetchedPeriods(h2)).toEqual(['2026-9']);
    expect(h2.linkProgress.days.size).toBe(0);
    expect(h2.cache.values.has(LEASE_KEY)).toBe(false);
  });

  it('stops starting new work once the quiet hour begins', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockImplementationOnce((period) => {
      h.clock.set('2026-10-05T18:00:00Z');
      return Promise.resolve(monthReports(period));
    });
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h)).toEqual(['2026-9']);
    expect(h.collectLinkProgress).not.toHaveBeenCalled();
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
  });

  it('a tick whose first month runs to 17:46 does not start the second', async () => {
    const h = makeDeps({ clock: new Clock('2026-10-05T17:30:00Z') });
    h.fetchMonthReports.mockImplementationOnce((period) => {
      h.clock.set('2026-10-05T17:46:00Z');
      return Promise.resolve(monthReports(period));
    });
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h)).toEqual(['2026-9']);
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
  });

  it('a month that ends in hour 17 does not start link progress', async () => {
    const h = makeDeps({ clock: new Clock('2026-10-05T16:59:00Z') });
    h.snapshots.seedBoth(SEPT, '2026-10-05T16:05:00Z');
    h.fetchMonthReports.mockImplementationOnce((period) => {
      h.clock.set('2026-10-05T17:01:00Z');
      return Promise.resolve(monthReports(period));
    });
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h)).toEqual(['2026-10']);
    expect(h.collectLinkProgress).not.toHaveBeenCalled();
  });

  it('plans with a fresh clock once the lease is held', async () => {
    // A tick that hung on Redis across midnight must plan for the new day.
    const h = makeDeps({ clock: new Clock('2026-10-05T23:58:00Z') });
    h.cacheSpy.mockImplementationOnce(() => {
      h.clock.set('2026-10-06T16:05:00Z');
      return Promise.resolve(h.cache);
    });
    await runBuildTick(h.deps);
    expect([...h.linkProgress.days.keys()]).toEqual(['2026-10-06']);
  });

  it('a missing Redis done-key does not rebuild a month Postgres shows as built', async () => {
    const h = makeDeps();
    h.snapshots.seedBoth(SEPT, '2026-10-05T16:05:00Z');
    h.snapshots.seedBoth(OCT, '2026-10-05T16:05:00Z');
    h.linkProgress.days.set('2026-10-05', {
      linked: 1,
      unlinked: 1,
      reverifyTagged: 0,
      onboarding: 0,
    });
    await runBuildTick(h.deps);
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(h.collectLinkProgress).not.toHaveBeenCalled();
  });

  it('a held lease skips the tick', async () => {
    const h = makeDeps();
    h.cache.values.set(LEASE_KEY, 'someone-else');
    await runBuildTick(h.deps);
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(h.collectLinkProgress).not.toHaveBeenCalled();
    expect(h.cache.values.get(LEASE_KEY)).toBe('someone-else');
  });

  it('lease release only removes its own claim', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockImplementationOnce((period) => {
      expect(h.cache.values.get(LEASE_KEY)).toBe('lease-1');
      // Our lease expired and another build took it.
      h.cache.values.set(LEASE_KEY, 'other');
      return Promise.resolve(monthReports(period));
    });
    await runBuildTick(h.deps);
    expect(h.cache.values.get(LEASE_KEY)).toBe('other');
  });
});

describe('runBuildTick builds', () => {
  it('builds the previous month before the current one and saves both report types', async () => {
    const h = makeDeps();
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h)).toEqual(['2026-9', '2026-10']);
    expect(
      h.snapshots.rows.map((r) => [
        r.reportType,
        `${r.period.year}-${r.period.month}`,
        r.mode,
        r.builtBy,
        r.sourceComplete,
        r.builtAt.toISOString(),
      ]),
    ).toEqual([
      [
        'hall_of_fame',
        '2026-9',
        'supersede',
        'job',
        true,
        '2026-10-05T16:15:00.000Z',
      ],
      [
        'no_show',
        '2026-9',
        'supersede',
        'job',
        true,
        '2026-10-05T16:15:00.000Z',
      ],
      [
        'hall_of_fame',
        '2026-10',
        'update-open',
        'job',
        true,
        '2026-10-05T16:15:00.000Z',
      ],
      [
        'no_show',
        '2026-10',
        'update-open',
        'job',
        true,
        '2026-10-05T16:15:00.000Z',
      ],
    ]);
    const [sept, oct] = h.fetchMonthReports.mock.calls;
    expect(sept[1].toISOString()).toBe('2026-10-01T07:00:00.000Z');
    expect(sept[2]?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(oct[1].toISOString()).toBe('2026-10-05T16:15:00.000Z');
    expect(oct[2]).toBeUndefined();
  });

  it('passes the finished-month asOf and suspension cutoff', async () => {
    const h = makeDeps();
    await runBuildTick(h.deps);
    const calls = h.fetchMonthReports.mock.calls.map(([p, asOf, cutoff]) => [
      `${p.year}-${p.month}`,
      asOf.toISOString(),
      cutoff === undefined ? 'undefined' : cutoff.toISOString(),
    ]);
    expect(calls).toEqual([
      ['2026-9', '2026-10-01T07:00:00.000Z', '2026-10-01T00:00:00.000Z'],
      ['2026-10', '2026-10-05T16:15:00.000Z', 'undefined'],
    ]);
  });

  it('the open month only reads Meetup inside fetchMonthReports, then saves', async () => {
    const h = makeDeps();
    const order: string[] = [];
    h.fetchMonthReports.mockImplementation((period) => {
      order.push(`fetch ${period.month}`);
      expect(
        h.snapshots.rows.filter((r) => r.period.month === period.month),
      ).toEqual([]);
      return Promise.resolve(monthReports(period));
    });
    const store = h.snapshots;
    h.deps.snapshots = {
      getCurrentMeta: (type, period) => store.getCurrentMeta(type, period),
      save: (write) => {
        order.push(`save ${write.period.month}`);
        return store.save(write);
      },
    };
    await runBuildTick(h.deps);
    expect(order).toEqual([
      'fetch 9',
      'save 9',
      'save 9',
      'fetch 10',
      'save 10',
      'save 10',
    ]);
  });

  it('a refresh that straddles the period end is not a finished build', async () => {
    // 06:55Z Oct 1 is 23:55 PDT Sept 30: September is still open.
    const h = makeDeps({ clock: new Clock('2026-10-01T06:55:00Z') });
    h.fetchMonthReports.mockImplementationOnce((period) => {
      h.clock.set('2026-10-01T07:05:00Z');
      return Promise.resolve(monthReports(period));
    });
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    expect(result.status).toBe('started');
    await (result as { done: Promise<{ ok: boolean }> }).done;
    expect(
      h.snapshots.rows.map((r) => [r.builtAt.toISOString(), r.mode]),
    ).toEqual([
      ['2026-10-01T06:55:00.000Z', 'update-open'],
      ['2026-10-01T06:55:00.000Z', 'update-open'],
    ]);
    // Not counted as built after the month ended: no report-ready...
    h.clock.set('2026-10-01T07:10:00Z');
    expect(await maybePostReportReady(h.deps)).toBe('skipped');
    // ...and September still catches up later.
    const builtAt = new Map<string, Date>();
    for (const type of REPORT_TYPES) {
      // eslint-disable-next-line no-await-in-loop -- two reads
      const meta = await h.snapshots.getCurrentMeta(type, SEPT);
      builtAt.set(snapshotKey(type, SEPT), meta.builtAt);
    }
    builtAt.set(
      snapshotKey('hall_of_fame', OCT),
      new Date('2026-10-08T16:01:00Z'),
    );
    builtAt.set(snapshotKey('no_show', OCT), new Date('2026-10-08T16:01:00Z'));
    expect(
      planDueWork({
        now: new Date('2026-10-08T16:15:00Z'),
        builtAt,
        linkProgressWrittenToday: true,
      }),
    ).toEqual([{ kind: 'month', period: SEPT, reason: 'previous-catch-up' }]);
  });

  it("the open month's daily build posts nothing on success", async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.snapshots.seedBoth(SEPT, '2026-10-05T16:05:00Z');
    h.linkProgress.days.set('2026-10-05', {
      linked: 1,
      unlinked: 1,
      reverifyTagged: 0,
      onboarding: 0,
    });
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h)).toEqual(['2026-10']);
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('posts a summary for a finished month built by the job', async () => {
    const h = makeDeps();
    await runBuildTick(h.deps);
    expect(titles(h.alert)).toEqual([
      'Reports built: September 2026',
      'Reports ready: September 2026', // the job's own build finishes the month
    ]);
    const [description] = descriptions(h.alert);
    expect(description).toContain('Hall of Fame: 4 events, 3 hosts (1 new).');
    expect(description).toContain(
      'No-shows: 8 no-show RSVPs; 2 warnings, 3 suspension candidates.',
    );
    expect(description).toContain('Built by the daily job.');
    expect(description).not.toContain('no no-shows recorded');
  });
});

describe('failure alerts', () => {
  it('failure releases the claim and alerts once per day', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockImplementation(failSeptember);
    await runBuildTick(h.deps);
    expect(titles(h.alert)).toEqual(['Report build failed: September 2026']);
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
    expect(h.cache.values.get('report-build-failing-2026-09')).toBe(
      '2026-10-05T16:15:00.000Z',
    );
    expect(h.cache.ttls.get('report-build-failing-2026-09')).toBe(
      8 * 24 * 60 * 60,
    );
    expect(h.cache.ttls.get('report-build-alerted-2026-09-2026-10-05')).toBe(
      26 * 60 * 60,
    );

    // The next attempt is an hour later (backoff), and does not alert again.
    h.clock.set('2026-10-05T17:15:00Z');
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h)).toEqual(['2026-9', '2026-10', '2026-9']);
    expect(titles(h.alert)).toEqual(['Report build failed: September 2026']);

    h.clock.set('2026-10-06T16:15:00Z');
    await runBuildTick(h.deps);
    expect(titles(h.alert)).toEqual([
      'Report build failed: September 2026',
      'Report build failed: September 2026',
    ]);
    // The failing marker keeps the first failure time.
    expect(h.cache.values.get('report-build-failing-2026-09')).toBe(
      '2026-10-05T16:15:00.000Z',
    );
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
  });

  it('alerts never carry a Meetup response body', async () => {
    const SENTINEL = 'RAW-BODY-SENTINEL-7f3a';
    const clientError = new ClientError(
      { status: 502, headers: new Headers(), body: SENTINEL },
      { query: '' },
    );
    expect(clientError.message).toContain(SENTINEL); // why it must never be shown
    const h = makeDeps();
    h.fetchMonthReports.mockRejectedValue(clientError);
    h.collectLinkProgress.mockRejectedValue(clientError);
    await runBuildTick(h.deps);
    expect(titles(h.alert)).toEqual([
      'Report build failed: September 2026',
      'Report build failed: October 2026',
      'Link progress not recorded',
    ]);
    descriptions(h.alert).forEach((d) => {
      expect(d).toContain('Meetup API error (HTTP 502)');
    });
    expect(JSON.stringify(h.alert.mock.calls)).not.toContain(SENTINEL);
  });

  it('an organizer-login failure shows its own message', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockRejectedValue(new OrganizerTokenUnavailableError());
    await runBuildTick(h.deps);
    expect(descriptions(h.alert)[0]).toContain('/dashboard/organizer-login');
  });

  it('describeBuildError: a GraphQL error on HTTP 200 shows neither body nor message', () => {
    const SENTINEL = 'RAW-GQL-SENTINEL-4d2e';
    const gqlError = new ClientError(
      {
        status: 200,
        headers: new Headers(),
        body: SENTINEL,
        errors: [{ message: SENTINEL } as never],
      },
      { query: SENTINEL },
    );
    expect(describeBuildError(gqlError)).toBe('Meetup GraphQL error');
    const emptyErrors = new ClientError(
      { status: 200, headers: new Headers(), body: SENTINEL, errors: [] },
      { query: '' },
    );
    expect(describeBuildError(emptyErrors)).toBe('Meetup API error (HTTP 200)');
  });

  it('describeBuildError: status only for ClientError, message only for organizer-safe errors', () => {
    const SENTINEL = 'RAW-BODY-SENTINEL-9b1c';
    const withErrors = new ClientError(
      {
        status: 400,
        headers: new Headers(),
        body: '',
        errors: [{ message: SENTINEL } as never],
      },
      { query: SENTINEL },
    );
    expect(describeBuildError(withErrors)).toBe('Meetup API error (HTTP 400)');
    const noStatus = new ClientError(
      { headers: new Headers(), body: SENTINEL } as never,
      { query: '' },
    );
    expect(describeBuildError(noStatus)).toBe(
      'Meetup API error (HTTP unknown)',
    );
    expect(describeBuildError(new OrganizerTokenUnavailableError())).toContain(
      '/dashboard/organizer-login',
    );
    expect(describeBuildError(new Error(SENTINEL))).toBe(
      'Error (details in the process log)',
    );
    expect(describeBuildError(SENTINEL)).not.toContain(SENTINEL);
  });

  it('a failed alert post is retried on the next tick', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockImplementation(failSeptember);
    h.alert.mockResolvedValueOnce(false);
    await runBuildTick(h.deps);
    expect(h.cache.values.has('report-build-alerted-2026-09-2026-10-05')).toBe(
      false,
    );

    h.clock.set('2026-10-05T17:15:00Z');
    await runBuildTick(h.deps);
    expect(titles(h.alert)).toEqual([
      'Report build failed: September 2026',
      'Report build failed: September 2026',
    ]);
    expect(await h.alert.mock.results[1].value).toBe(true);
    expect(h.cache.values.has('report-build-alerted-2026-09-2026-10-05')).toBe(
      true,
    );
  });

  it('recovery alert after failures', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementationOnce(() =>
      Promise.reject(new Error('boom')),
    );
    await runBuildTick(h.deps);
    expect(titles(h.alert)).toEqual(['Report build failed: September 2026']);

    h.clock.set('2026-10-05T17:15:00Z');
    await runBuildTick(h.deps);
    expect(titles(h.alert)).toEqual([
      'Report build failed: September 2026',
      'Report build working again: September 2026',
      'Reports built: September 2026',
    ]);
    expect(h.cache.values.has('report-build-failing-2026-09')).toBe(false);

    h.clock.set('2026-10-06T16:15:00Z');
    await runBuildTick(h.deps);
    expect(
      titles(h.alert).filter((t) => t.startsWith('Report build working again')),
    ).toHaveLength(1);
  });

  it('a failed recovery post keeps the failing marker for the next success', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementationOnce(() =>
      Promise.reject(new Error('boom')),
    );
    await runBuildTick(h.deps);
    h.alert.mockResolvedValueOnce(false); // the recovery post
    h.clock.set('2026-10-05T17:15:00Z');
    await runBuildTick(h.deps);
    expect(h.cache.values.has('report-build-failing-2026-09')).toBe(true);
  });
});

describe('failure backoff', () => {
  const BACKOFF = 'report-build-backoff-2026-09';

  it('a failing month is retried at most once an hour', async () => {
    const h = makeDeps({
      clock: new Clock('2026-10-05T16:00:00Z'),
      reportReadyEnabled: false,
    });
    h.fetchMonthReports.mockImplementation(failSeptember);
    const septAttempts: string[] = [];
    for (const at of ['16:00', '16:15', '16:30', '16:45', '17:00']) {
      h.clock.set(`2026-10-05T${at}:00Z`);
      const before = fetchedPeriods(h).filter((p) => p === '2026-9').length;
      // eslint-disable-next-line no-await-in-loop -- ticks are sequential
      await runBuildTick(h.deps);
      if (fetchedPeriods(h).filter((p) => p === '2026-9').length > before) {
        septAttempts.push(at);
      }
    }
    expect(septAttempts).toEqual(['16:00', '17:00']);
    expect(h.cache.ttls.get(BACKOFF)).toBe(3600);

    // A success clears the backoff.
    h.fetchMonthReports.mockImplementation((period) =>
      Promise.resolve(monthReports(period)),
    );
    h.clock.set('2026-10-06T16:15:00Z');
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h).filter((p) => p === '2026-9')).toHaveLength(3);
    expect(h.cache.values.has(BACKOFF)).toBe(false);
  });

  it('a backed-off month is skipped, not a stop: later items still run', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.cache.values.set(BACKOFF, '2026-10-05T16:00:00.000Z');
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h)).toEqual(['2026-10']);
    expect(h.linkProgress.days.has('2026-10-05')).toBe(true);
  });

  it('skips the month when the backoff key cannot be read (fail closed)', async () => {
    const clock = new Clock('2026-10-05T16:15:00Z');
    class BrokenBackoffCache extends ExpiringCache {
      override async get(key: string) {
        if (key.startsWith('report-build-backoff-')) {
          throw new Error('redis down');
        }
        return super.get(key);
      }
    }
    const h = makeDeps({
      clock,
      cache: new BrokenBackoffCache(clock),
      reportReadyEnabled: false,
    });
    await runBuildTick(h.deps);
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(h.linkProgress.days.has('2026-10-05')).toBe(true);
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
  });

  it('a manual rebuild ignores the backoff, and a manual failure sets it', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.cache.values.set(BACKOFF, 'x');
    const ok = await requestRebuild(h.deps, SEPT, REQUESTER);
    expect(await (ok as { done: Promise<{ ok: boolean }> }).done).toEqual({
      ok: true,
    });
    expect(fetchedPeriods(h)).toEqual(['2026-9']);
    expect(h.cache.values.has(BACKOFF)).toBe(false); // cleared by the success

    h.fetchMonthReports.mockImplementation(failSeptember);
    h.cache.values.delete('report-rebuild-cooldown-2026-09'); // ten minutes later
    const septFail = await requestRebuild(h.deps, SEPT, REQUESTER);
    await (septFail as { done: Promise<{ ok: boolean }> }).done;
    expect(h.cache.values.get(BACKOFF)).toBe('2026-10-05T16:15:00.000Z');
    expect(h.cache.ttls.get(BACKOFF)).toBe(3600);
  });

  it('the job failure alert names the 17:45–19:00 window and the hourly retry', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockImplementation(failSeptember);
    await runBuildTick(h.deps);
    const [description] = descriptions(h.alert);
    expect(description).toContain(
      'It retries at most once an hour (never 17:45–19:00 UTC); this alert repeats at most once a day until it works.',
    );
    expect(description).not.toContain('18:00–19:00');
  });
});

describe('finished-month summary', () => {
  const septWith = (noShows: number) => (period: Period) => {
    const reports = monthReports(period);
    if (isSept(period)) {
      reports.noShow.summary.noShows = noShows;
    }
    return Promise.resolve(reports);
  };
  const septSummaries = (h: ReturnType<typeof makeDeps>) =>
    titles(h.alert).filter((t) => t === 'Reports built: September 2026').length;

  it('the job posts it on the first finished build and when it changes, days 2–7', async () => {
    const h = makeDeps({
      clock: new Clock('2026-10-02T16:15:00Z'),
      reportReadyEnabled: false,
    });
    // An open-month build from September 30th with the same numbers does not
    // count: day 2 is still the first finished build.
    h.snapshots.seedBoth(SEPT, '2026-09-30T16:05:00Z');
    const posted: number[] = [];
    for (const day of [2, 3, 4, 5, 6, 7]) {
      h.fetchMonthReports.mockImplementation(septWith(day >= 5 ? 9 : 8));
      h.clock.set(`2026-10-0${day}T16:15:00Z`);
      const before = septSummaries(h);
      // eslint-disable-next-line no-await-in-loop -- one day at a time
      await runBuildTick(h.deps);
      if (septSummaries(h) > before) {
        posted.push(day);
      }
    }
    expect(fetchedPeriods(h).filter((p) => p === '2026-9')).toHaveLength(6);
    expect(posted).toEqual([2, 5]);
    const last = descriptions(h.alert).filter((d) =>
      d.includes('9 no-show RSVPs'),
    );
    expect(last).toHaveLength(1);
  });

  it('a Hall of Fame change alone posts it too', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.snapshots.seedBoth(SEPT, '2026-10-04T16:05:00Z');
    await runBuildTick(h.deps);
    expect(septSummaries(h)).toBe(0);
    h.fetchMonthReports.mockImplementation((period) => {
      const reports = monthReports(period);
      reports.hallOfFame.summary.newHosts = 2;
      return Promise.resolve(reports);
    });
    h.clock.set('2026-10-06T16:15:00Z');
    await runBuildTick(h.deps);
    expect(septSummaries(h)).toBe(1);
  });

  it('compares summaries regardless of key order (JSONB reorders keys)', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.snapshots.seed('hall_of_fame', SEPT, '2026-10-04T16:05:00Z', {
      summary: { newHosts: 1, hosts: 3, events: 4 },
    });
    h.snapshots.seed('no_show', SEPT, '2026-10-04T16:05:00Z', {
      summary: {
        departed: 1,
        cleared: 1,
        suspensionCandidates: 3,
        warnings: 2,
        members: 7,
        noShows: 8,
      },
    });
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h)).toContain('2026-9');
    expect(septSummaries(h)).toBe(0);
  });

  it('the zero-no-show note follows the same rule', async () => {
    const zero = { pastEventsWithRsvps: 6, eventsWithNoShow: 0, noShows: 0 };
    const h = makeDeps({
      clock: new Clock('2026-10-02T16:15:00Z'),
      reportReadyEnabled: false,
    });
    h.fetchMonthReports.mockImplementation((period) =>
      Promise.resolve(monthReports(period, zero)),
    );
    await runBuildTick(h.deps);
    h.clock.set('2026-10-03T16:15:00Z');
    await runBuildTick(h.deps);
    expect(
      descriptions(h.alert).filter((d) => d.includes('no no-shows recorded')),
    ).toHaveLength(1);
  });

  it('manual and backfill-style builds still post every time', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.snapshots.seedBoth(SEPT, '2026-10-04T16:05:00Z');
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    await (result as { done: Promise<{ ok: boolean }> }).done;
    expect(septSummaries(h)).toBe(1);
  });

  it('posts when the earlier summaries cannot be read', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.snapshots.seedBoth(SEPT, '2026-10-04T16:05:00Z');
    const store = h.snapshots;
    let reads = 0;
    h.deps.snapshots = {
      save: (write) => store.save(write),
      getCurrentMeta: (type, period) => {
        reads += 1;
        // loadBuiltAt reads four rows first; the summary pre-read fails.
        return reads > 4
          ? Promise.reject(new Error('pg down'))
          : store.getCurrentMeta(type, period);
      },
    };
    await runBuildTick(h.deps);
    expect(septSummaries(h)).toBe(1);
    expect(h.snapshots.rows).toHaveLength(4);
  });
});

describe('departed guard', () => {
  const withMembers =
    (members: number, departed: number, onlySept = true) =>
    (period: Period) => {
      const reports = monthReports(period);
      if (!onlySept || isSept(period)) {
        reports.noShow.summary.members = members;
        reports.noShow.summary.departed = departed;
      }
      return Promise.resolve(reports);
    };

  it('refuses to save a finished month where every no-show member looks departed', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementation(withMembers(7, 7));
    await runBuildTick(h.deps);
    expect(h.snapshots.rows.filter((r) => isSept(r.period))).toEqual([]);
    expect(titles(h.alert)).toEqual(['Report build failed: September 2026']);
    expect(descriptions(h.alert)[0]).toContain(
      'Every member with a no-show in September 2026 looks like they have left the group; ' +
        'the organizer account may not be able to see memberships. Nothing was saved.',
    );
    expect(h.cache.values.has('report-build-backoff-2026-09')).toBe(true);
  });

  it('saves when at least one member is still present', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementation(withMembers(7, 6));
    await runBuildTick(h.deps);
    expect(h.snapshots.rows.filter((r) => isSept(r.period))).toHaveLength(2);
  });

  it('saves a month with no no-show members', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementation(withMembers(0, 0));
    await runBuildTick(h.deps);
    expect(h.snapshots.rows.filter((r) => isSept(r.period))).toHaveLength(2);
  });

  it('does not apply to the open month', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.snapshots.seedBoth(SEPT, '2026-10-05T16:05:00Z');
    h.fetchMonthReports.mockImplementation(withMembers(7, 7, false));
    await runBuildTick(h.deps);
    expect(h.snapshots.rows.filter((r) => r.period.month === 10)).toHaveLength(
      2,
    );
  });

  const DEPARTED_NOTE = 'have left the group';

  it('refuses three of three departed members', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementation(withMembers(3, 3));
    await runBuildTick(h.deps);
    expect(h.snapshots.rows.filter((r) => isSept(r.period))).toEqual([]);
    expect(titles(h.alert)).toEqual(['Report build failed: September 2026']);
  });

  it('saves two of two and notes it', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementation(withMembers(2, 2));
    await runBuildTick(h.deps);
    expect(h.snapshots.rows.filter((r) => isSept(r.period))).toHaveLength(2);
    expect(titles(h.alert)).toContain('Reports built: September 2026');
    const notes = descriptions(h.alert).flatMap((d) =>
      d.split('\n').filter((line) => line.includes(DEPARTED_NOTE)),
    );
    expect(notes).toEqual(['Note: all 2 no-show members have left the group.']);
  });

  it('saves one of one and notes it', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementation(withMembers(1, 1));
    await runBuildTick(h.deps);
    expect(h.snapshots.rows.filter((r) => isSept(r.period))).toHaveLength(2);
    const notes = descriptions(h.alert).flatMap((d) =>
      d.split('\n').filter((line) => line.includes(DEPARTED_NOTE)),
    );
    expect(notes).toEqual(['Note: all 1 no-show members have left the group.']);
  });

  it('no departed note when someone stayed', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementation(withMembers(7, 6));
    await runBuildTick(h.deps);
    expect(titles(h.alert)).toContain('Reports built: September 2026');
    expect(
      descriptions(h.alert).filter((d) => d.includes(DEPARTED_NOTE)),
    ).toEqual([]);
  });

  it('no departed note for a month with no no-show members', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementation(withMembers(0, 0));
    const outcome = await buildMonth(h.deps, SEPT, 'job');
    expect(outcome.allDeparted).toBe(false);
    expect(buildSummaryEntry(outcome).description).not.toContain(DEPARTED_NOTE);
  });

  it('allowAllDeparted saves a month the guard would refuse', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementation(withMembers(5, 5));
    const outcome = await buildMonth(h.deps, SEPT, 'backfill', {
      allowAllDeparted: true,
    });
    expect(outcome.allDeparted).toBe(true);
    expect(h.snapshots.rows.filter((r) => isSept(r.period))).toHaveLength(2);
    expect(buildSummaryEntry(outcome).description).toContain(
      'Note: all 5 no-show members have left the group.',
    );
  });

  it('without allowAllDeparted, buildMonth refuses five of five', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementation(withMembers(5, 5));
    await expect(buildMonth(h.deps, SEPT, 'backfill')).rejects.toThrow(
      MembershipsUnreadableError,
    );
    await expect(
      buildMonth(h.deps, SEPT, 'backfill', { allowAllDeparted: false }),
    ).rejects.toThrow(MembershipsUnreadableError);
    expect(h.snapshots.rows).toEqual([]);
  });

  it('a manual refresh never skips the guard', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementation(withMembers(5, 5));
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    expect(result.status).toBe('started');
    if (result.status === 'started') {
      expect(await result.done).toEqual({ ok: false });
    }
    expect(h.snapshots.rows.filter((r) => isSept(r.period))).toEqual([]);
    expect(titles(h.alert)).toEqual(['Report build failed: September 2026']);
  });

  it('builds with only now, snapshots and fetchMonthReports', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementation(withMembers(2, 2));
    const deps: MonthBuildDeps = {
      now: h.deps.now,
      snapshots: h.deps.snapshots,
      fetchMonthReports: h.deps.fetchMonthReports,
    };
    const outcome = await buildMonth(deps, SEPT, 'backfill');
    expect(outcome.allDeparted).toBe(true);
    expect(h.snapshots.rows).toHaveLength(2);
  });

  it('the guard minimum is three', () => {
    expect(DEPARTED_GUARD_MIN_MEMBERS).toBe(3);
  });

  it('the open month never carries the note', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.clock.set('2026-10-05T16:15:00Z');
    h.fetchMonthReports.mockImplementation(withMembers(2, 2, false));
    const outcome = await buildMonth(h.deps, OCT, 'job');
    expect(outcome.finished).toBe(false);
    expect(outcome.allDeparted).toBe(false);
    expect(buildSummaryEntry(outcome).description).not.toContain(DEPARTED_NOTE);
  });
});

describe('attendance note', () => {
  const ZERO = { pastEventsWithRsvps: 6, eventsWithNoShow: 0, noShows: 0 };

  it('notes a finished month with no no-shows', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockImplementation((period) =>
      Promise.resolve(monthReports(period, isSept(period) ? ZERO : undefined)),
    );
    await runBuildTick(h.deps);
    expect(titles(h.alert)).toEqual([
      'Reports built: September 2026',
      'Reports ready: September 2026', // the job's own build finishes the month
    ]);
    expect(descriptions(h.alert)[0]).toContain(
      'Note: no no-shows recorded for September 2026 across 6 past events with RSVPs; check that attendance was taken.',
    );
    const noShowSave = h.snapshots.rows.find(
      (r) => r.reportType === 'no_show' && isSept(r.period),
    );
    expect(noShowSave.sourceComplete).toBe(true);
    expect(ready(h)).toHaveLength(1);
  });

  it('no note for an open month with no no-shows', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockImplementation((period) =>
      Promise.resolve(monthReports(period, ZERO)),
    );
    const result = await requestRebuild(h.deps, OCT, REQUESTER);
    await (result as { done: Promise<{ ok: boolean }> }).done;
    expect(titles(h.alert)).toEqual(['Reports built: October 2026']);
    expect(descriptions(h.alert)[0]).not.toContain('no no-shows recorded');
  });

  it('no note when a finished month has no past events with RSVPs', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockImplementation((period) =>
      Promise.resolve(
        monthReports(period, {
          pastEventsWithRsvps: 0,
          eventsWithNoShow: 0,
          noShows: 0,
        }),
      ),
    );
    await runBuildTick(h.deps);
    expect(titles(h.alert)).toEqual([
      'Reports built: September 2026',
      'Reports ready: September 2026', // the job's own build finishes the month
    ]);
    expect(descriptions(h.alert)[0]).not.toContain('no no-shows recorded');
  });
});

describe('report-ready', () => {
  // Oct 10: September is past its daily rebuilds and already has a finished build.
  function settled(options: Parameters<typeof makeDeps>[0] = {}) {
    const h = makeDeps({
      clock: new Clock('2026-10-10T16:15:00Z'),
      ...options,
    });
    if (!options.snapshots) {
      h.snapshots.seedBoth(SEPT, '2026-10-03T16:10:00Z');
      h.snapshots.seedBoth(OCT, '2026-10-10T16:05:00Z');
    }
    if (!options.linkProgress) {
      h.linkProgress.days.set('2026-10-10', {
        linked: 1,
        unlinked: 1,
        reverifyTagged: 0,
        onboarding: 0,
      });
    }
    return h;
  }

  it('is on', () => {
    expect(REPORT_READY_ENABLED).toBe(true);
  });

  it('report-ready is a plain alert with the counts and month links', async () => {
    const h = settled();
    await runBuildTick(h.deps);
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(ready(h)).toEqual([
      {
        title: 'Reports ready: September 2026',
        description: [
          'No-shows: 2 warnings, 3 suspension candidates.',
          'Hall of Fame: 4 events, 3 hosts (1 new).',
          'No-show workspace: https://meetup-discord-bot.herokuapp.com/dashboard/no-shows/2026-09',
          'Hall of Fame page: https://meetup-discord-bot.herokuapp.com/dashboard/hall-of-fame/2026-09',
          'No-show history page: https://meetup-discord-bot.herokuapp.com/dashboard/no-show-history/2026-09',
        ].join('\n'),
      },
    ]);
  });

  it('report-ready never mentions anyone', async () => {
    const h = settled();
    await runBuildTick(h.deps);
    expect(ready(h)).toHaveLength(1);
    expect(JSON.stringify(h.alert.mock.calls)).not.toMatch(
      /<@|@everyone|@here/,
    );
  });

  it('report-ready counts tolerate a malformed stored summary', () => {
    expect(reportReadyEntry(SEPT, null, { warnings: 'x' }).description).toMatch(
      /^No-shows: 0 warnings, 0 suspension candidates\./,
    );
  });

  it('report-ready posts once per period across restarts', async () => {
    const clock = new Clock('2026-10-10T16:15:00Z');
    const notices = new FakeNoticeStore(() => clock.now().getTime());
    const snapshots = new FakeSnapshotStore();
    snapshots.seedBoth(SEPT, '2026-10-03T16:10:00Z');
    snapshots.seedBoth(OCT, '2026-10-10T16:05:00Z');
    const first = settled({ clock, notices, snapshots });
    await runBuildTick(first.deps);
    clock.set('2026-10-10T16:30:00Z');
    const second = settled({
      clock,
      notices: notices.caller(),
      snapshots,
      cache: new FakeCache(),
    });
    await runBuildTick(second.deps);
    // Past the reclaim window: a posted marker is final, so nothing re-posts.
    clock.set('2026-10-10T17:01:00Z');
    const third = settled({
      clock,
      notices: notices.caller(),
      snapshots,
      cache: new FakeCache(),
    });
    await runBuildTick(third.deps);
    expect(
      ready(first).length + ready(second).length + ready(third).length,
    ).toBe(1);
    expect(notices.isPosted('report_ready', SEPT)).toBe(true);
  });

  it('report-ready for the latest finished month even when the backfill built it', async () => {
    const snapshots = new FakeSnapshotStore();
    snapshots.seedBoth(SEPT, '2026-10-03T16:10:00Z', { builtBy: 'backfill' });
    snapshots.seedBoth(OCT, '2026-10-10T16:05:00Z');
    const h = settled({ snapshots });
    await runBuildTick(h.deps);
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(ready(h)).toHaveLength(1);
  });

  it('report-ready waits for a build made after the month ended', async () => {
    const h = makeDeps({ clock: new Clock('2026-10-01T16:15:00Z') });
    h.snapshots.seedBoth(SEPT, '2026-09-30T16:10:00Z');
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h)).toEqual(['2026-10']); // no previous-month build on the 1st
    expect(h.notices.claim).not.toHaveBeenCalled();
    expect(ready(h)).toHaveLength(0);
  });

  it('report-ready waits for both rows', async () => {
    const snapshots = new FakeSnapshotStore();
    snapshots.seed('hall_of_fame', SEPT, '2026-10-03T16:10:00Z');
    snapshots.seed('no_show', SEPT, '2026-09-30T16:10:00Z');
    const h = settled({ snapshots });
    expect(await maybePostReportReady(h.deps)).toBe('skipped');
    expect(ready(h)).toHaveLength(0);
  });

  it('failed report-ready post is retried', async () => {
    const h = settled();
    h.alert.mockResolvedValueOnce(false);
    await runBuildTick(h.deps);
    expect(h.notices.release).toHaveBeenCalledWith('report_ready', SEPT);
    expect(h.notices.isPosted('report_ready', SEPT)).toBe(false);

    h.clock.set('2026-10-10T16:30:00Z');
    await runBuildTick(h.deps);
    expect(ready(h)).toHaveLength(2);
    expect(h.notices.isPosted('report_ready', SEPT)).toBe(true);
  });

  it('report-ready after a crash between claim and post is posted on a later tick', async () => {
    const h = settled();
    // The "crashed" process: it claimed and never posted or released.
    expect(await h.notices.claim('report_ready', SEPT)).toBe('fresh');
    h.clock.set('2026-10-10T16:30:00Z');
    await runBuildTick(h.deps);
    expect(ready(h)).toHaveLength(0); // inside the reclaim window
    h.clock.set('2026-10-10T16:46:00Z');
    await runBuildTick(h.deps);
    expect(ready(h)).toHaveLength(1);
    expect(h.recentAlertTitles).toHaveBeenCalledTimes(1);
    expect(h.notices.isPosted('report_ready', SEPT)).toBe(true);
  });

  it('a retry that finds its notice in the channel marks it posted without posting again', async () => {
    const h = settled();
    h.alert.mockResolvedValueOnce(false); // e.g. a timeout on a send that landed
    h.recentAlertTitles.mockResolvedValue([
      'Reports built: October 2026',
      'Reports ready: September 2026',
    ]);
    await runBuildTick(h.deps);
    expect(h.recentAlertTitles).not.toHaveBeenCalled();
    h.clock.set('2026-10-10T16:30:00Z');
    await runBuildTick(h.deps);
    expect(ready(h)).toHaveLength(1); // the "failed" one only
    expect(h.recentAlertTitles).toHaveBeenCalledTimes(1);
    expect(h.notices.isPosted('report_ready', SEPT)).toBe(true);
  });

  it('a retry posts when the channel history cannot be read', async () => {
    const h = settled();
    h.alert.mockResolvedValueOnce(false);
    h.recentAlertTitles.mockResolvedValue(undefined);
    await runBuildTick(h.deps);
    h.clock.set('2026-10-10T16:30:00Z');
    await runBuildTick(h.deps);
    expect(ready(h)).toHaveLength(2);
    expect(h.notices.isPosted('report_ready', SEPT)).toBe(true);
  });

  it('a retry posts when reading the channel history throws', async () => {
    const h = settled();
    h.alert.mockResolvedValueOnce(false);
    h.recentAlertTitles.mockRejectedValue(new Error('discord down'));
    await runBuildTick(h.deps);
    h.clock.set('2026-10-10T16:30:00Z');
    expect(await maybePostReportReady(h.deps)).toBe('posted');
    expect(ready(h)).toHaveLength(2);
  });

  it('a retry does not match a different month in the channel', async () => {
    const h = settled();
    h.alert.mockResolvedValueOnce(false);
    h.recentAlertTitles.mockResolvedValue(['Reports ready: August 2026']);
    await runBuildTick(h.deps);
    h.clock.set('2026-10-10T16:30:00Z');
    await runBuildTick(h.deps);
    expect(ready(h)).toHaveLength(2);
  });

  it('a fresh claim never reads the channel history', async () => {
    const h = settled();
    await runBuildTick(h.deps);
    expect(ready(h)).toHaveLength(1);
    expect(h.recentAlertTitles).not.toHaveBeenCalled();
    expect(h.notices.markPosted).toHaveBeenCalledWith('report_ready', SEPT);
  });

  it('a markPosted failure after a post does not post again inside the reclaim window', async () => {
    const h = settled();
    h.notices.markPosted.mockRejectedValueOnce(new Error('pg down'));
    expect(await maybePostReportReady(h.deps)).toBe('failed');
    expect(ready(h)).toHaveLength(1);
    h.clock.set('2026-10-10T16:30:00Z');
    await runBuildTick(h.deps);
    expect(ready(h)).toHaveLength(1);
  });

  it('claim and release go to the same notice store', async () => {
    const h = settled();
    h.alert.mockResolvedValueOnce(false);
    expect(await maybePostReportReady(h.deps)).toBe('failed');
    expect(h.notices.claim).toHaveBeenCalledTimes(1);
    expect(h.notices.release).toHaveBeenCalledTimes(1);
  });

  it('report-ready is off while REPORT_READY_ENABLED is false', async () => {
    const h = settled({ reportReadyEnabled: false });
    await runBuildTick(h.deps);
    expect(h.notices.claim).not.toHaveBeenCalled();
    expect(ready(h)).toHaveLength(0);
  });

  it('a store error is reported as failed, not thrown', async () => {
    const h = settled();
    h.notices.claim.mockRejectedValueOnce(new Error('pg down'));
    expect(await maybePostReportReady(h.deps)).toBe('failed');
  });
});

describe('link progress', () => {
  it('writes link progress once per day', async () => {
    const h = makeDeps();
    await runBuildTick(h.deps);
    expect(h.linkProgress.days.get('2026-10-05')).toEqual({
      linked: 10,
      unlinked: 5,
      reverifyTagged: 2,
      onboarding: 1,
    });
    h.clock.set('2026-10-05T16:30:00Z');
    await runBuildTick(h.deps);
    expect(h.collectLinkProgress).toHaveBeenCalledTimes(1);
    h.clock.set('2026-10-06T16:15:00Z');
    await runBuildTick(h.deps);
    expect(h.collectLinkProgress).toHaveBeenCalledTimes(2);
    expect(h.linkProgress.days.has('2026-10-06')).toBe(true);
  });

  it('a link-progress failure alerts once per day and does not stop the month builds', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.collectLinkProgress.mockRejectedValue(new Error('discord down'));
    await runBuildTick(h.deps);
    expect(h.snapshots.rows).toHaveLength(4);
    expect(titles(h.alert)).toEqual([
      'Reports built: September 2026',
      'Link progress not recorded',
    ]);
    expect(descriptions(h.alert)[1]).toContain(
      'Error (details in the process log)',
    );

    h.clock.set('2026-10-05T16:30:00Z');
    await runBuildTick(h.deps);
    expect(h.collectLinkProgress).toHaveBeenCalledTimes(2);
    expect(
      titles(h.alert).filter((t) => t === 'Link progress not recorded'),
    ).toHaveLength(1);
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
  });
});

describe('requestRebuild', () => {
  it('requestRebuild refuses while a build runs', async () => {
    const h = makeDeps();
    h.cache.values.set(LEASE_KEY, 'other');
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    expect(result.status).toBe('busy');
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
  });

  it('requestRebuild refused from 17:45 UTC, allowed at 17:44', async () => {
    const h = makeDeps({ clock: new Clock('2026-10-05T17:45:00Z') });
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    expect(result).toEqual({
      status: 'quiet-hour',
      message:
        'Reports are not rebuilt between 17:45 and 19:00 UTC while the daily identity sweep runs. Try again after 19:00 UTC.',
    });
    expect(h.cacheSpy).not.toHaveBeenCalled();
    h.clock.set('2026-10-05T17:44:59.999Z');
    expect((await requestRebuild(h.deps, SEPT, REQUESTER)).status).toBe(
      'started',
    );
  });

  it('requestRebuild refused 18:00–19:00 UTC', async () => {
    const h = makeDeps({ clock: new Clock('2026-10-05T18:10:00Z') });
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    expect(result.status).toBe('quiet-hour');
    expect((result as { message: string }).message).toContain(
      'after 19:00 UTC',
    );
    expect(h.cacheSpy).not.toHaveBeenCalled();
  });

  it('requestRebuild defers while the identity digest is running', async () => {
    const h = makeDeps();
    h.cache.values.set('identity-digest-2026-10-05', 'x');
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    expect(result.status).toBe('identity-sweep');
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
  });

  it('requestRebuild refuses a future month and a non-digit requester', async () => {
    const h = makeDeps();
    expect(
      (await requestRebuild(h.deps, { year: 2026, month: 11 }, REQUESTER))
        .status,
    ).toBe('future-month');
    expect((await requestRebuild(h.deps, SEPT, 'job')).status).toBe(
      'bad-requester',
    );
    expect((await requestRebuild(h.deps, SEPT, '<@1>')).status).toBe(
      'bad-requester',
    );
    expect((await requestRebuild(h.deps, SEPT, '')).status).toBe(
      'bad-requester',
    );
    expect(h.cacheSpy).not.toHaveBeenCalled();
  });

  it('requestRebuild records the requester as built_by, posts the summary and releases the lease', async () => {
    const h = makeDeps();
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    expect(result.status).toBe('started');
    expect(h.cache.values.get(LEASE_KEY)).toBe('lease-1');
    expect(await (result as { done: Promise<{ ok: boolean }> }).done).toEqual({
      ok: true,
    });
    expect(h.snapshots.rows.map((r) => r.builtBy)).toEqual([
      REQUESTER,
      REQUESTER,
    ]);
    expect(titles(h.alert)).toEqual(['Reports built: September 2026']);
    expect(descriptions(h.alert)[0]).toContain(`<@${REQUESTER}>`);
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
    expect(ready(h)).toHaveLength(0); // manual rebuilds never post report-ready
  });

  it('a failed manual rebuild alerts and releases the lease', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockRejectedValue(new Error('boom'));
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    await expect(
      (result as { done: Promise<{ ok: boolean }> }).done,
    ).resolves.toEqual({ ok: false });
    expect(titles(h.alert)).toEqual(['Report build failed: September 2026']);
    const [description] = descriptions(h.alert);
    expect(description).not.toContain('retries every 15 minutes');
    expect(description).toContain(
      'Try the refresh again later; the daily job retries only months that are due.',
    );
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
  });

  it("a failed manual rebuild does not use up the job's daily alert for the month", async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementation(failSeptember);
    const manual = await requestRebuild(h.deps, SEPT, REQUESTER);
    await (manual as { done: Promise<{ ok: boolean }> }).done;
    expect(h.cache.values.has('report-build-alerted-2026-09-2026-10-05')).toBe(
      false,
    );
    // The manual failure set the hourly backoff; the job's next attempt
    // still has its own daily alert available.
    h.clock.set('2026-10-05T17:20:00Z');
    await runBuildTick(h.deps);
    expect(titles(h.alert)).toEqual([
      'Report build failed: September 2026',
      'Report build failed: September 2026',
    ]);
    expect(descriptions(h.alert)[1]).toContain('retries at most once an hour');
  });

  it('requestRebuild refuses the same month again within 10 minutes', async () => {
    const h = makeDeps();
    const first = await requestRebuild(h.deps, SEPT, REQUESTER);
    expect(first.status).toBe('started');
    await (first as { done: Promise<{ ok: boolean }> }).done;
    expect(h.cache.ttls.get('report-rebuild-cooldown-2026-09')).toBe(600);

    h.clock.set('2026-10-05T16:20:00Z');
    const again = await requestRebuild(h.deps, SEPT, '987654321');
    expect(again).toEqual({
      status: 'cooldown',
      message:
        'That month was refreshed in the last 10 minutes. Try again in a few minutes.',
    });
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
    // Another month is not affected.
    const oct = await requestRebuild(h.deps, OCT, REQUESTER);
    expect(oct.status).toBe('started');
    await (oct as { done: Promise<{ ok: boolean }> }).done;
    expect(h.fetchMonthReports).toHaveBeenCalledTimes(2);

    // After the TTL the key is gone (FakeCache does not expire; simulate it).
    h.cache.values.delete('report-rebuild-cooldown-2026-09');
    expect((await requestRebuild(h.deps, SEPT, REQUESTER)).status).toBe(
      'started',
    );
  });

  it('a refused request does not start the cooldown', async () => {
    const h = makeDeps();
    h.cache.values.set(LEASE_KEY, 'other');
    expect((await requestRebuild(h.deps, SEPT, REQUESTER)).status).toBe('busy');
    h.cache.values.set('identity-digest-2026-10-05', 'x');
    expect((await requestRebuild(h.deps, SEPT, REQUESTER)).status).toBe(
      'identity-sweep',
    );
    expect(h.cache.values.has('report-rebuild-cooldown-2026-09')).toBe(false);
  });

  it('requestRebuild refuses a malformed month', async () => {
    const h = makeDeps();
    const bad: Period[] = [
      { year: 2026, month: 0 },
      { year: 2026, month: 13 },
      { year: 2026, month: 9.5 },
      { year: 1999, month: 12 },
      { year: 2000, month: 1 },
      { year: 2013, month: 2 },
      { year: 2026.5, month: 9 },
      { year: Number.NaN, month: 9 },
      { year: 2026, month: '9' as unknown as number },
    ];
    for (const period of bad) {
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      const result = await requestRebuild(h.deps, period, REQUESTER);
      expect(result).toEqual({
        status: 'bad-month',
        message: 'That is not a valid month.',
      });
    }
    expect(h.cacheSpy).not.toHaveBeenCalled();
    expect(
      (await requestRebuild(h.deps, { year: 2013, month: 3 }, REQUESTER))
        .status,
    ).toBe('started');
  });
});

describe('buildSummaryEntry', () => {
  const outcome = (builtBy: string) => ({
    period: SEPT,
    builtBy,
    durationMs: 1200,
    sourceComplete: true,
    finished: true,
    summaryIsNew: true,
    hallOfFame: { events: 4, hosts: 3, newHosts: 1 },
    noShow: {
      noShows: 8,
      members: 7,
      warnings: 2,
      suspensionCandidates: 3,
      cleared: 1,
      departed: 1,
    },
    attendance: { pastEventsWithRsvps: 6, eventsWithNoShow: 5, noShows: 8 },
    allDeparted: false,
  });

  it('only renders a user mention for an all-digit builtBy', () => {
    expect(buildSummaryEntry(outcome('job')).description).toContain(
      'Built by the daily job.',
    );
    expect(buildSummaryEntry(outcome('backfill')).description).toContain(
      'Built by the backfill.',
    );
    expect(buildSummaryEntry(outcome(REQUESTER)).description).toContain(
      `Built by <@${REQUESTER}>.`,
    );
    for (const builtBy of ['@everyone', '<@&912474048775221270>', 'abc', '']) {
      const description = buildSummaryEntry(outcome(builtBy)).description;
      expect(description).toContain('Built by a staff member.');
      expect(description).not.toContain('<@');
      expect(description).not.toContain('@everyone');
    }
  });
});

describe('buildMonth', () => {
  it('measures the build from start to saved', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockImplementationOnce((period) => {
      h.clock.set('2026-10-05T16:15:02.500Z');
      return Promise.resolve(monthReports(period));
    });
    const outcome = await buildMonth(h.deps, SEPT, 'job');
    expect(outcome.durationMs).toBe(2500);
    expect(outcome.finished).toBe(true);
    expect(h.snapshots.rows[0].builtAt.toISOString()).toBe(
      '2026-10-05T16:15:00.000Z',
    );
  });
});

describe('defaultBuildJobDeps', () => {
  it('defaultBuildJobDeps reads Meetup only through the organizer wrapper', async () => {
    const snapshots = { save: vi.fn(), getCurrentMeta: vi.fn() };
    const notices = { claim: vi.fn(), release: vi.fn() };
    const linkProgress = { hasDay: vi.fn(), upsertDay: vi.fn() };
    const suspensions = { listByMemberIds: vi.fn() };
    vi.mocked(PostgresReportSnapshotRepository.instance).mockResolvedValue(
      snapshots as never,
    );
    vi.mocked(PostgresDashboardNoticeRepository.instance).mockResolvedValue(
      notices as never,
    );
    vi.mocked(PostgresLinkProgressRepository.instance).mockResolvedValue(
      linkProgress as never,
    );
    vi.mocked(PostgresSuspensionRepository.instance).mockResolvedValue(
      suspensions as never,
    );
    const meetupClient = {} as GqlMeetupClient;
    vi.mocked(withOrganizerMeetup).mockImplementation((_client, fn) =>
      fn(meetupClient),
    );
    const reports = monthReports(SEPT);
    vi.mocked(buildMonthReports).mockResolvedValue(reports);
    const client = {} as Client;

    const deps = await defaultBuildJobDeps(client);
    // The build job's cache is the untimed shared one: a Redis drop must
    // hang the tick so the wedged-tick alert fires (dashboard timeouts are
    // dashboard-scoped only).
    expect(deps.cache).toBe(ApplicationCache);
    expect(deps.snapshots).toBe(snapshots);
    expect(deps.notices).toBe(notices);
    expect(deps.linkProgress).toBe(linkProgress);
    expect(deps.reportReadyEnabled()).toBe(true);

    const asOf = new Date('2026-10-01T07:00:00Z');
    const cutoff = new Date('2026-10-01T00:00:00Z');
    expect(await deps.fetchMonthReports(SEPT, asOf, cutoff)).toBe(reports);
    // Through the shared factory: the uncached organizer client.
    expect(withOrganizerMeetup).toHaveBeenCalledWith(
      client,
      expect.any(Function),
      defaultOrganizerMeetupDeps,
    );
    expect(buildMonthReports).toHaveBeenCalledWith(meetupClient, SEPT, {
      asOf,
      suspensionCutoff: cutoff,
      groupId: '7595882',
      suspensions,
    });

    const entry = { title: 't' };
    await deps.alert(entry);
    expect(logAlert).toHaveBeenCalledWith(client, entry);
    expect(deps).not.toHaveProperty('postRoleNotice');
    vi.mocked(recentEmbedTitles).mockResolvedValue(['x']);
    expect(await deps.recentAlertTitles()).toEqual(['x']);
    expect(recentEmbedTitles).toHaveBeenCalledWith(
      client,
      BOT_ALERTS_CHANNEL_ID,
    );
    await deps.collectLinkProgress();
    expect(collectLinkProgress).toHaveBeenCalledWith(client);
    expect(deps.newLeaseValue()).not.toBe(deps.newLeaseValue());
    expect(deps.newLeaseValue()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('fake store sanity', () => {
  it("FakeNoticeStore.markPosted succeeds only for the caller's current, unposted claim", async () => {
    const clock = new Clock('2026-10-10T16:15:00Z');
    const a = new FakeNoticeStore(() => clock.now().getTime());
    const b = a.caller(); // another process on the same table
    // No claim of its own.
    expect(await b.markPosted('report_ready', SEPT)).toBe(false);
    expect(await a.claim('report_ready', SEPT)).toBe('fresh');
    expect(await b.markPosted('report_ready', SEPT)).toBe(false);
    expect(a.isPosted('report_ready', SEPT)).toBe(false);
    // b takes over the crashed claim: a's markPosted no longer lands.
    clock.set('2026-10-10T16:46:00Z');
    expect(await b.claim('report_ready', SEPT)).toBe('retry');
    expect(await a.markPosted('report_ready', SEPT)).toBe(false);
    expect(await b.markPosted('report_ready', SEPT)).toBe(true);
    expect(a.isPosted('report_ready', SEPT)).toBe(true);
    // A claim is used once.
    expect(await b.markPosted('report_ready', SEPT)).toBe(false);
  });

  it("FakeNoticeStore.release touches only the caller's current claim", async () => {
    const clock = new Clock('2026-10-10T16:15:00Z');
    const a = new FakeNoticeStore(() => clock.now().getTime());
    const b = a.caller();
    expect(await a.claim('report_ready', SEPT)).toBe('fresh');
    await b.release('report_ready', SEPT); // not b's claim
    expect(await b.claim('report_ready', SEPT)).toBe(false);
    await a.release('report_ready', SEPT);
    expect(await b.claim('report_ready', SEPT)).toBe('retry');
  });

  it('FakeLinkProgressStore and FakeSnapshotStore behave like the repositories', async () => {
    const store = new FakeLinkProgressStore();
    expect(await store.hasDay('2026-10-05')).toBe(false);
    const snaps = new FakeSnapshotStore();
    snaps.seed('no_show', SEPT, '2026-10-02T16:00:00Z');
    snaps.seed('no_show', SEPT, '2026-10-03T16:00:00Z');
    expect(
      (await snaps.getCurrentMeta('no_show', SEPT)).builtAt.toISOString(),
    ).toBe('2026-10-03T16:00:00.000Z');
    expect(await snaps.getCurrentMeta('hall_of_fame', SEPT)).toBeUndefined();
  });
});

describe('month page links', () => {
  // Literal strings, never recomputed from the helper under test.
  const HOF_LINK =
    'Hall of Fame page: https://meetup-discord-bot.herokuapp.com/dashboard/hall-of-fame/2026-09';
  const NO_SHOW_LINK =
    'No-show history page: https://meetup-discord-bot.herokuapp.com/dashboard/no-show-history/2026-09';
  const WORKSPACE_LINK =
    'No-show workspace: https://meetup-discord-bot.herokuapp.com/dashboard/no-shows/2026-09';
  const linkLines = (description: string) =>
    description.split('\n').filter((line) => line.includes('https://'));
  const outcome = (period: Period) => ({
    period,
    builtBy: 'job',
    durationMs: 1200,
    sourceComplete: true,
    finished: true,
    summaryIsNew: true,
    hallOfFame: { events: 4, hosts: 3, newHosts: 1 },
    noShow: {
      noShows: 8,
      members: 7,
      warnings: 2,
      suspensionCandidates: 3,
      cleared: 1,
      departed: 1,
    },
    attendance: { pastEventsWithRsvps: 6, eventsWithNoShow: 5, noShows: 8 },
    allDeparted: false,
  });

  it('the build summary links the month pages', async () => {
    const h = makeDeps();
    await runBuildTick(h.deps);
    expect(titles(h.alert)).toEqual([
      'Reports built: September 2026',
      'Reports ready: September 2026', // the job's own build finishes the month
    ]);
    expect(descriptions(h.alert)[0]).toBe(
      [
        'Hall of Fame: 4 events, 3 hosts (1 new).',
        'No-shows: 8 no-show RSVPs; 2 warnings, 3 suspension candidates.',
        'Took 0.0 s. Built by the daily job.',
        WORKSPACE_LINK,
        HOF_LINK,
        NO_SHOW_LINK,
      ].join('\n'),
    );
  });

  it('the links come before the notes', () => {
    const description = buildSummaryEntry({
      ...outcome(SEPT),
      noShow: { ...outcome(SEPT).noShow, members: 2, departed: 2 },
      attendance: { pastEventsWithRsvps: 6, eventsWithNoShow: 0, noShows: 0 },
      allDeparted: true,
    }).description;
    const lines = description.split('\n');
    expect(lines.slice(2)).toEqual([
      'Took 1.2 s. Built by the daily job.',
      WORKSPACE_LINK,
      HOF_LINK,
      NO_SHOW_LINK,
      'Note: no no-shows recorded for September 2026 across 6 past events with RSVPs; check that attendance was taken.',
      'Note: all 2 no-show members have left the group.',
    ]);
  });

  it('the failure alert links the month pages', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockImplementation(failSeptember);
    await runBuildTick(h.deps);
    expect(titles(h.alert)).toEqual(['Report build failed: September 2026']);
    // The error text still comes only from describeBuildError.
    expect(descriptions(h.alert)[0]).toBe(
      `Building the September 2026 reports failed after 0.0 s: ${describeBuildError(new Error('boom'))}\n\n` +
        'It retries at most once an hour (never 17:45–19:00 UTC); this alert repeats at most once a day until it works.\n\n' +
        `${WORKSPACE_LINK}\n${HOF_LINK}\n${NO_SHOW_LINK}`,
    );
  });

  it('the manual failure alert links the month pages', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockRejectedValue(new Error('boom'));
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    await (result as { done: Promise<{ ok: boolean }> }).done;
    expect(titles(h.alert)).toEqual(['Report build failed: September 2026']);
    expect(linkLines(descriptions(h.alert)[0])).toEqual([
      WORKSPACE_LINK,
      HOF_LINK,
      NO_SHOW_LINK,
    ]);
  });

  it('links carry no Meetup-derived text', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockImplementation((period) => {
      const reports = monthReports(period);
      reports.hallOfFame.period = 'EVIL';
      reports.noShow.period = '../x';
      reports.hallOfFame.hosts = [
        {
          host: {
            id: '1',
            name: 'https://evil.example/<x>',
            memberUrl: 'https://evil.example/<x>',
          },
          isNew: true,
          events: [],
        },
      ];
      return Promise.resolve(reports);
    });
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    await (result as { done: Promise<{ ok: boolean }> }).done;
    expect(titles(h.alert)).toEqual(['Reports built: September 2026']);
    const [description] = descriptions(h.alert);
    const lines = description
      .split('\n')
      .filter((line) => line.includes('https://'));
    expect(lines).toEqual([WORKSPACE_LINK, HOF_LINK, NO_SHOW_LINK]);
    expect(description.toLowerCase()).not.toContain('evil');
    expect(description).not.toContain('../x');
  });

  it("links come from the build's period, not the payload", async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockImplementation((period) => {
      const reports = monthReports(period);
      reports.hallOfFame.period = '2026-08';
      reports.noShow.period = '2026-08';
      return Promise.resolve(reports);
    });
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    await (result as { done: Promise<{ ok: boolean }> }).done;
    const [description] = descriptions(h.alert);
    expect(linkLines(description)).toEqual([
      WORKSPACE_LINK,
      HOF_LINK,
      NO_SHOW_LINK,
    ]);
    expect(description).not.toContain('2026-08');
  });

  it('an invalid period gets no links and still posts', () => {
    for (const period of [
      { year: 2026, month: 13 },
      { year: 2026, month: 0 },
      { year: 2026, month: 9.5 },
      { year: '../x' as unknown as number, month: 9 },
    ]) {
      let entry: ReturnType<typeof buildSummaryEntry> | undefined;
      expect(() => {
        entry = buildSummaryEntry(outcome(period));
      }).not.toThrow();
      expect(entry?.description).toContain('Hall of Fame: 4 events');
      expect(linkLines(entry?.description ?? '')).toEqual([]);
      expect(entry?.description).not.toContain('2026-13');
      expect(entry?.description).not.toContain('/dashboard/');
    }
  });

  it('build summaries and failures link the workspace for workspace months only', async () => {
    const AUG: Period = { year: 2026, month: 8 };
    const AUG_LINKS = [
      'Hall of Fame page: https://meetup-discord-bot.herokuapp.com/dashboard/hall-of-fame/2026-08',
      'No-show history page: https://meetup-discord-bot.herokuapp.com/dashboard/no-show-history/2026-08',
    ];
    expect(linkLines(buildSummaryEntry(outcome(SEPT)).description)).toEqual([
      WORKSPACE_LINK,
      HOF_LINK,
      NO_SHOW_LINK,
    ]);

    // A manual rebuild of August (before the workspace): built, then failed.
    const built = makeDeps();
    const ok = await requestRebuild(built.deps, AUG, REQUESTER);
    await (ok as { done: Promise<{ ok: boolean }> }).done;
    expect(titles(built.alert)).toEqual(['Reports built: August 2026']);
    expect(linkLines(descriptions(built.alert)[0])).toEqual(AUG_LINKS);

    const failed = makeDeps();
    failed.fetchMonthReports.mockRejectedValue(new Error('boom'));
    const bad = await requestRebuild(failed.deps, AUG, REQUESTER);
    await (bad as { done: Promise<{ ok: boolean }> }).done;
    expect(titles(failed.alert)).toEqual(['Report build failed: August 2026']);
    expect(linkLines(descriptions(failed.alert)[0])).toEqual(AUG_LINKS);

    // Report-ready for August (announced in September) links history, not a workspace.
    const notice = reportReadyEntry(AUG, {}, {}).description;
    expect(linkLines(notice)).toEqual(AUG_LINKS);
    expect(notice).not.toContain('/no-shows/');
    expect(notice).not.toContain('workspace');
  });

  it('a month before the group began gets no links (the dashboard 404s it)', () => {
    expect(
      linkLines(
        buildSummaryEntry(outcome({ year: 2013, month: 2 })).description,
      ),
    ).toEqual([]);
    expect(
      linkLines(
        buildSummaryEntry(outcome({ year: 2013, month: 3 })).description,
      ),
    ).toEqual([
      'Hall of Fame page: https://meetup-discord-bot.herokuapp.com/dashboard/hall-of-fame/2013-03',
      'No-show history page: https://meetup-discord-bot.herokuapp.com/dashboard/no-show-history/2013-03',
    ]);
  });

  it('a month before the group began can be neither requested nor built', async () => {
    const h = makeDeps();
    expect(
      (await requestRebuild(h.deps, { year: 2013, month: 2 }, REQUESTER))
        .status,
    ).toBe('bad-month');
    // buildMonth has its own floor, so the backfill (or any later caller)
    // cannot build or save a month before GROUP_FIRST_PERIOD.
    await expect(
      buildMonth(h.deps, { year: 2013, month: 2 }, 'backfill'),
    ).rejects.toBeInstanceOf(MonthBeforeGroupBuildError);
    await expect(
      buildMonth(h.deps, { year: 2012, month: 12 }, 'job'),
    ).rejects.toBeInstanceOf(MonthBeforeGroupBuildError);
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(h.snapshots.rows).toEqual([]);
    expect(
      describeBuildError(
        new MonthBeforeGroupBuildError({ year: 2013, month: 2 }),
      ),
    ).toBe(
      "February 2013 is before the group's first month (March 2013); nothing was built.",
    );
    // The first month itself builds.
    const built = await buildMonth(
      h.deps,
      { year: 2013, month: 3 },
      'backfill',
    );
    expect(built.period).toEqual({ year: 2013, month: 3 });
  });

  it('alerts stay embeds with no mentions', async () => {
    const h = makeDeps();
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    await (result as { done: Promise<{ ok: boolean }> }).done;
    h.fetchMonthReports.mockImplementation(failSeptember);
    h.cache.values.delete('report-rebuild-cooldown-2026-09');
    const failed = await requestRebuild(h.deps, SEPT, REQUESTER);
    await (failed as { done: Promise<{ ok: boolean }> }).done;
    expect(titles(h.alert)).toEqual([
      'Reports built: September 2026',
      'Report build failed: September 2026',
    ]);
    expect(ready(h)).toHaveLength(0);
    for (const [entry] of h.alert.mock.calls) {
      expect(Object.keys(entry)).toEqual(['title', 'description']);
      expect(entry).not.toHaveProperty('content');
      expect(entry.description).not.toContain('<@&');
      expect(entry.description).not.toContain('@everyone');
      expect(entry.description).not.toContain('@here');
    }
  });
});

describe('workspace sync hooks', () => {
  const AUG: Period = { year: 2026, month: 8 };
  const synced = (h: Harness) =>
    h.syncWorkspace.mock.calls.map(([p]) => `${p.year}-${p.month}`);
  const workspaceAlerts = (h: Harness) =>
    titles(h.alert).filter((t) => t.startsWith('No-show workspace'));
  const LINK = { linked: 1, unlinked: 1, reverifyTagged: 0, onboarding: 0 };

  /** Oct 10: nothing is due; September is finished and built. */
  function idle() {
    const h = makeDeps({ clock: new Clock('2026-10-10T16:15:00Z') });
    h.snapshots.seedBoth(SEPT, '2026-10-03T16:10:00Z');
    h.snapshots.seedBoth(OCT, '2026-10-10T16:05:00Z');
    h.linkProgress.days.set('2026-10-10', LINK);
    return h;
  }

  it('syncs the workspace after a job build of a workspace month, after its saves', async () => {
    const h = makeDeps();
    const savedWhenSynced: number[] = [];
    h.syncWorkspace.mockImplementation(async (period) => {
      savedWhenSynced.push(
        h.snapshots.rows.filter(
          (r) =>
            r.period.year === period.year && r.period.month === period.month,
        ).length,
      );
      return 'synced';
    });
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h)).toEqual(['2026-9', '2026-10']);
    expect(synced(h)).toEqual(['2026-9', '2026-10']);
    expect(savedWhenSynced).toEqual([2, 2]);
  });

  it('syncs the latest finished and the open month on every tick, even when nothing is due', async () => {
    const h = idle();
    await runBuildTick(h.deps);
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(synced(h)).toEqual(['2026-9', '2026-10']);
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
  });

  it('a tick that does nothing (quiet hour, before 16:00) syncs nothing', async () => {
    for (const at of ['2026-10-10T18:30:00Z', '2026-10-10T15:59:00Z']) {
      const h = makeDeps({ clock: new Clock(at) });
      // eslint-disable-next-line no-await-in-loop -- two independent ticks, one at a time
      await runBuildTick(h.deps);
      expect(h.syncWorkspace).not.toHaveBeenCalled();
    }
  });

  it("never syncs months before the workspace's first month", async () => {
    const h = makeDeps({ clock: new Clock('2026-09-10T16:15:00Z') });
    h.snapshots.seedBoth(AUG, '2026-09-03T16:10:00Z');
    h.snapshots.seedBoth(SEPT, '2026-09-10T16:05:00Z');
    h.linkProgress.days.set('2026-09-10', LINK);
    await runBuildTick(h.deps);
    expect(synced(h)).toEqual(['2026-9']);
  });

  it('syncs the months it built before report-ready, the rest after; link progress keeps its place', async () => {
    const h = makeDeps({ clock: new Clock('2026-10-05T16:15:00Z') });
    const order: string[] = [];
    h.alert.mockImplementation(async (entry) => {
      order.push(entry.title);
      return true;
    });
    h.collectLinkProgress.mockImplementation(async () => {
      order.push('link progress');
      return { ...LINK };
    });
    h.syncWorkspace.mockImplementation(async (period) => {
      order.push(`sync ${period.month}`);
      return 'synced';
    });
    await runBuildTick(h.deps);
    expect(order).toEqual([
      'Reports built: September 2026',
      'link progress',
      'sync 9',
      'sync 10',
      'Reports ready: September 2026',
    ]);
  });

  /** Oct 17: September was backfilled after it ended (no sync then), October is due. */
  function backfilledSeptember() {
    const h = makeDeps({ clock: new Clock('2026-10-17T16:15:00Z') });
    h.snapshots.seedBoth(SEPT, '2026-10-02T03:00:00Z', {
      builtBy: 'backfill',
    });
    h.linkProgress.days.set('2026-10-17', LINK);
    return h;
  }

  it.each([
    ['this tick built it (Oct 5)', () => makeDeps()],
    ['it was backfilled and only October is due (Oct 17)', backfilledSeptember],
  ])(
    "report-ready posts only once its month's workspace sync has finished: %s",
    async (_name, harness) => {
      const h = harness();
      const finished = new Set<number>();
      let septemberSyncedWhenPosted: boolean | undefined;
      h.alert.mockImplementation(async (entry) => {
        if (entry.title === 'Reports ready: September 2026') {
          septemberSyncedWhenPosted = finished.has(9);
        }
        return true;
      });
      h.syncWorkspace.mockImplementation(async (period) => {
        // A sync that takes a few turns of the event loop.
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        finished.add(period.month);
        return 'synced';
      });
      await runBuildTick(h.deps);
      expect(ready(h)).toHaveLength(1);
      expect(septemberSyncedWhenPosted).toBe(true);
      // Each month once: September is not synced again after the notice.
      expect(synced(h).sort()).toEqual(['2026-10', '2026-9']);
    },
  );

  it('a backfilled month whose sync rejects is still announced', async () => {
    const h = backfilledSeptember();
    h.syncWorkspace.mockImplementation(async (period) => {
      if (period.month === 9) {
        throw new Error('down');
      }
      return 'synced';
    });
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h)).toEqual(['2026-10']);
    expect(ready(h)).toHaveLength(1);
    expect(synced(h)).toEqual(['2026-10', '2026-9']);
  });

  it('a backfilled month whose sync hangs is still announced, after at most the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = backfilledSeptember();
      h.syncWorkspace.mockImplementation(async (period) => {
        if (period.month === 9) {
          return new Promise(() => undefined);
        }
        return 'synced';
      });
      const tick = runBuildTick(h.deps);
      await vi.advanceTimersByTimeAsync(WORKSPACE_SYNC_DEADLINE_MS - 1);
      expect(ready(h)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await tick;
      expect(ready(h)).toHaveLength(1);
      expect(synced(h)).toEqual(['2026-10', '2026-9']);
      expect(h.cache.values.has(LEASE_KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('only the current month built: it and then the previous month sync before report-ready', async () => {
    const h = makeDeps({ clock: new Clock('2026-10-10T16:15:00Z') });
    h.snapshots.seedBoth(SEPT, '2026-10-03T16:10:00Z');
    h.snapshots.seedBoth(OCT, '2026-10-09T16:05:00Z');
    h.linkProgress.days.set('2026-10-10', LINK);
    const order: string[] = [];
    h.alert.mockImplementation(async (entry) => {
      order.push(entry.title);
      return true;
    });
    h.syncWorkspace.mockImplementation(async (period) => {
      order.push(`sync ${period.month}`);
      return 'current';
    });
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h)).toEqual(['2026-10']);
    expect(order).toEqual([
      'sync 10',
      'sync 9',
      'Reports ready: September 2026',
    ]);
  });

  it('report-ready still posts when the sync of a built month throws', async () => {
    const h = makeDeps();
    h.syncWorkspace.mockRejectedValue(new Error('down'));
    await runBuildTick(h.deps);
    expect(ready(h)).toHaveLength(1);
  });

  it('report-ready still posts, after the deadline, when the sync of a built month hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = makeDeps();
      h.syncWorkspace.mockImplementation(() => new Promise(() => undefined));
      const tick = runBuildTick(h.deps);
      await vi.advanceTimersByTimeAsync(WORKSPACE_SYNC_DEADLINE_MS - 1);
      expect(ready(h)).toHaveLength(0);
      // September's deadline, then October's.
      await vi.advanceTimersByTimeAsync(WORKSPACE_SYNC_DEADLINE_MS + 2);
      await tick;
      expect(ready(h)).toHaveLength(1);
      expect(h.syncWorkspace).toHaveBeenCalledTimes(2);
      expect(h.cache.values.has(LEASE_KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failing workspace sync alerts once a day and does not fail the build or the tick', async () => {
    const h = makeDeps();
    const error = vi.spyOn(Logger.prototype, 'error');
    h.syncWorkspace.mockRejectedValue(
      new TypeError('relation "noshow_workspace_rows" does not exist: secret'),
    );
    await expect(runBuildTick(h.deps)).resolves.toBeUndefined();
    // The builds were saved, link progress written, report-ready posted.
    expect(h.snapshots.rows).toHaveLength(4);
    expect(h.linkProgress.days.has('2026-10-05')).toBe(true);
    expect(ready(h)).toHaveLength(1);
    expect(workspaceAlerts(h)).toEqual([
      'No-show workspace not updated: September 2026',
      'No-show workspace not updated: October 2026',
    ]);
    const description = descriptions(h.alert).find((d) =>
      d.startsWith('The September 2026 workspace'),
    );
    expect(description).toBe(
      'The September 2026 workspace could not be updated from the stored report (TypeError). ' +
        'It retries after the next build and on every build tick.',
    );
    // The process log names the error class only.
    const logged = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('Workspace sync 2026-09 failed: TypeError');
    expect(logged).not.toContain('secret');
    expect(logged).not.toContain('noshow_workspace_rows');
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);

    // Later the same day: no second alert.
    h.alert.mockClear();
    h.clock.set('2026-10-05T16:30:00Z');
    await runBuildTick(h.deps);
    expect(h.syncWorkspace.mock.calls.length).toBeGreaterThan(2);
    expect(workspaceAlerts(h)).toEqual([]);

    // The next day: alerted again.
    h.alert.mockClear();
    h.clock.set('2026-10-06T16:15:00Z');
    await runBuildTick(h.deps);
    expect(workspaceAlerts(h)).toEqual([
      'No-show workspace not updated: September 2026',
      'No-show workspace not updated: October 2026',
    ]);
  });

  it('a malformed stored report alerts once a day with a fixed reason, and the notice still posts', async () => {
    const h = idle();
    h.syncWorkspace.mockImplementation(async (period) => {
      return isSept(period) ? 'malformed' : 'current';
    });
    await runBuildTick(h.deps);
    expect(ready(h)).toHaveLength(1);
    expect(workspaceAlerts(h)).toEqual([
      'No-show workspace not updated: September 2026',
    ]);
    expect(
      descriptions(h.alert).find((d) => d.startsWith('The September 2026')),
    ).toBe(
      'The September 2026 workspace could not be updated from the stored report ' +
        '(the stored no-show report is not in the expected shape). ' +
        'It retries after the next build and on every build tick.',
    );

    // Later the same day: no second alert.
    h.alert.mockClear();
    h.clock.set('2026-10-10T16:30:00Z');
    await runBuildTick(h.deps);
    expect(workspaceAlerts(h)).toEqual([]);
  });

  it('a malformed outcome whose meta read hangs gives up after a short deadline, silently', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = idle();
      const meta = vi.spyOn(h.snapshots, 'getCurrentMeta');
      h.syncWorkspace.mockImplementation(async (period) => {
        if (!isSept(period)) {
          return 'current';
        }
        // The malformed path's own meta read never settles.
        meta.mockImplementationOnce(() => new Promise(() => undefined));
        return 'malformed';
      });
      let done = false;
      const tick = runBuildTick(h.deps).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(
        WORKSPACE_MALFORMED_META_DEADLINE_MS - 1,
      );
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await tick;
      expect(done).toBe(true);
      expect(workspaceAlerts(h)).toEqual([]);
      expect(ready(h)).toHaveLength(1);
      expect(h.cache.values.has(LEASE_KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a malformed outcome for a month with no current no-show snapshot stays silent', async () => {
    const h = makeDeps({ clock: new Clock('2026-10-10T16:15:00Z') });
    // Only Hall of Fame stored for September; October is current.
    h.snapshots.seed('hall_of_fame', SEPT, '2026-10-03T16:10:00Z');
    h.snapshots.seedBoth(OCT, '2026-10-10T16:05:00Z');
    h.linkProgress.days.set('2026-10-10', LINK);
    h.fetchMonthReports.mockRejectedValue(new Error('not now'));
    h.syncWorkspace.mockImplementation(async (period) => {
      return isSept(period) ? 'malformed' : 'current';
    });
    await runBuildTick(h.deps);
    expect(synced(h)).toContain('2026-9');
    expect(workspaceAlerts(h)).toEqual([]);
  });

  it("'no-report' stays silent", async () => {
    const h = idle();
    h.syncWorkspace.mockImplementation(async (period) => {
      return isSept(period) ? 'no-report' : 'current';
    });
    await runBuildTick(h.deps);
    expect(synced(h)).toEqual(['2026-9', '2026-10']);
    expect(workspaceAlerts(h)).toEqual([]);
  });

  it('a workspace alert that fails to post is retried on the next tick', async () => {
    const h = idle();
    h.syncWorkspace.mockImplementation(async (period) => {
      if (isSept(period)) {
        throw new Error('down');
      }
      return 'current';
    });
    let failNext = true;
    h.alert.mockImplementation(async (entry) => {
      if (entry.title.startsWith('No-show workspace') && failNext) {
        failNext = false;
        return false;
      }
      return true;
    });
    await runBuildTick(h.deps);
    expect(workspaceAlerts(h)).toEqual([
      'No-show workspace not updated: September 2026',
    ]);
    expect(failNext).toBe(false);
    h.alert.mockClear();
    h.clock.set('2026-10-10T16:30:00Z');
    await runBuildTick(h.deps);
    expect(workspaceAlerts(h)).toEqual([
      'No-show workspace not updated: September 2026',
    ]);
  });

  it('an unreadable alert key or a throwing alert never fails the tick', async () => {
    const h = idle();
    h.syncWorkspace.mockRejectedValue(new Error('down'));
    vi.spyOn(h.cache, 'exclusive_set').mockImplementation(async (key) => {
      if (key.startsWith('workspace-sync-alerted-')) {
        throw new Error('redis down');
      }
      return true;
    });
    await expect(runBuildTick(h.deps)).resolves.toBeUndefined();
    expect(h.syncWorkspace).toHaveBeenCalledTimes(2);
  });

  it('a hung workspace sync is given up on after its deadline; the tick finishes and releases the lease', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = idle();
      h.syncWorkspace.mockImplementation(() => new Promise(() => undefined));
      let finished = false;
      const tick = runBuildTick(h.deps).then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(WORKSPACE_SYNC_DEADLINE_MS - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(WORKSPACE_SYNC_DEADLINE_MS + 1);
      await tick;
      expect(finished).toBe(true);
      expect(workspaceAlerts(h)).toEqual([
        'No-show workspace not updated: September 2026',
        'No-show workspace not updated: October 2026',
      ]);
      expect(h.cache.values.has(LEASE_KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the deadline is at most 30 s', () => {
    expect(WORKSPACE_SYNC_DEADLINE_MS).toBeGreaterThan(0);
    expect(WORKSPACE_SYNC_DEADLINE_MS).toBeLessThanOrEqual(30_000);
  });

  it('manual rebuilds sync too, after the build is saved, and before the lease is released', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.syncWorkspace.mockImplementation(async () => {
      expect(h.snapshots.rows).toHaveLength(2);
      expect(h.cache.values.has(LEASE_KEY)).toBe(true);
      return 'synced';
    });
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    expect(await (result as { done: Promise<{ ok: boolean }> }).done).toEqual({
      ok: true,
    });
    expect(synced(h)).toEqual(['2026-9']);
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
  });

  it('a manual rebuild of a month before the workspace does not sync it', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    const result = await requestRebuild(h.deps, AUG, REQUESTER);
    await (result as { done: Promise<{ ok: boolean }> }).done;
    expect(h.snapshots.rows).toHaveLength(2);
    expect(h.syncWorkspace).not.toHaveBeenCalled();
  });

  it('a failed manual rebuild does not sync', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.fetchMonthReports.mockImplementation(failSeptember);
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    expect(await (result as { done: Promise<{ ok: boolean }> }).done).toEqual({
      ok: false,
    });
    expect(h.syncWorkspace).not.toHaveBeenCalled();
  });

  it('a failing sync does not fail a manual rebuild', async () => {
    const h = makeDeps({ reportReadyEnabled: false });
    h.syncWorkspace.mockRejectedValue(new Error('down'));
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    expect(await (result as { done: Promise<{ ok: boolean }> }).done).toEqual({
      ok: true,
    });
    expect(workspaceAlerts(h)).toEqual([
      'No-show workspace not updated: September 2026',
    ]);
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
  });

  it("buildMonth alone (the backfill's path) never syncs", async () => {
    const h = makeDeps();
    await buildMonth(h.deps, SEPT, 'backfill');
    await buildMonth(h.deps, OCT, 'backfill');
    expect(h.snapshots.rows).toHaveLength(4);
    expect(h.syncWorkspace).not.toHaveBeenCalled();
  });

  it('the tick works without a syncWorkspace dep', async () => {
    const h = makeDeps();
    delete h.deps.syncWorkspace;
    await runBuildTick(h.deps);
    expect(h.snapshots.rows).toHaveLength(4);
    expect(ready(h)).toHaveLength(1);
    expect(h.syncWorkspace).not.toHaveBeenCalled();
  });

  it('defaultBuildJobDeps opens the workspace repository only when a sync needs it', async () => {
    const snapshots = {
      save: vi.fn(),
      getCurrentMeta: vi.fn(async () => undefined),
      getCurrent: vi.fn(async () => undefined),
    };
    vi.mocked(PostgresReportSnapshotRepository.instance).mockResolvedValue(
      snapshots as never,
    );
    vi.mocked(PostgresDashboardNoticeRepository.instance).mockResolvedValue(
      {} as never,
    );
    vi.mocked(PostgresLinkProgressRepository.instance).mockResolvedValue(
      {} as never,
    );
    vi.mocked(PostgresSuspensionRepository.instance).mockResolvedValue(
      {} as never,
    );
    const syncFromSnapshot = vi.fn(async () => ({
      status: 'synced' as const,
      created: 0,
      reclassified: 0,
      dropped: 0,
      returned: 0,
    }));
    vi.mocked(PostgresNoShowWorkspaceRepository.instance).mockResolvedValue({
      syncFromSnapshot,
      monthState: vi.fn(async () => undefined),
    } as never);
    const deps = await defaultBuildJobDeps({} as Client);
    expect(PostgresNoShowWorkspaceRepository.instance).not.toHaveBeenCalled();
    // Before the workspace: nothing read, nothing opened.
    expect(await deps.syncWorkspace?.({ year: 2013, month: 3 })).toBe(
      'not-eligible',
    );
    expect(snapshots.getCurrent).not.toHaveBeenCalled();
    // No report yet: the workspace schema is still not touched.
    const current = periodOf(new Date());
    expect(await deps.syncWorkspace?.(current)).toBe('no-report');
    expect(PostgresNoShowWorkspaceRepository.instance).not.toHaveBeenCalled();
    expect(snapshots.getCurrent).not.toHaveBeenCalled();
    // A stored report: synced through the workspace repository.
    snapshots.getCurrentMeta.mockResolvedValueOnce({
      id: 3,
      builtAt: new Date('2026-10-02T16:00:00Z'),
    });
    snapshots.getCurrent.mockResolvedValueOnce({
      id: 3,
      builtAt: new Date('2026-10-02T16:00:00Z'),
      payload: { reportType: 'no_show', cases: [] },
    });
    expect(await deps.syncWorkspace?.(current)).toBe('synced');
    expect(PostgresNoShowWorkspaceRepository.instance).toHaveBeenCalledTimes(1);
    expect(syncFromSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ period: current, snapshotId: 3, cases: [] }),
    );
  });

  it('a workspace repository that cannot be opened rejects the sync, never the deps', async () => {
    vi.mocked(PostgresReportSnapshotRepository.instance).mockResolvedValue({
      getCurrentMeta: vi.fn(async () => ({ id: 3, builtAt: new Date() })),
      getCurrent: vi.fn(async () => ({
        id: 3,
        builtAt: new Date(),
        payload: { reportType: 'no_show', cases: [] },
      })),
    } as never);
    vi.mocked(PostgresDashboardNoticeRepository.instance).mockResolvedValue(
      {} as never,
    );
    vi.mocked(PostgresLinkProgressRepository.instance).mockResolvedValue(
      {} as never,
    );
    vi.mocked(PostgresSuspensionRepository.instance).mockResolvedValue(
      {} as never,
    );
    vi.mocked(PostgresNoShowWorkspaceRepository.instance).mockRejectedValue(
      new Error('relation "suspension_records" does not exist'),
    );
    const deps = await defaultBuildJobDeps({} as Client);
    await expect(deps.syncWorkspace?.(periodOf(new Date()))).rejects.toThrow(
      'suspension_records',
    );
  });
});

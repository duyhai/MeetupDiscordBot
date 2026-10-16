/* eslint-disable
  @typescript-eslint/unbound-method,
*/
import { Client } from 'discord.js';
import { ClientError } from 'graphql-request';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BOT_ALERTS_CHANNEL_ID, SERVER_ROLES } from '../../../src/constants.js';
import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import {
  logAlert,
  postRoleNotice,
} from '../../../src/lib/helpers/discordLogger.js';
import {
  buildMonth,
  defaultBuildJobDeps,
  describeBuildError,
  maybePostReportReady,
  REPORT_READY_ENABLED,
  REPORT_READY_ROLE_IDS,
  reportMonthUrl,
  requestRebuild,
  runBuildTick,
} from '../../../src/lib/reports/buildJob.js';
import {
  planDueWork,
  snapshotKey,
} from '../../../src/lib/reports/buildSchedule.js';
import { collectLinkProgress } from '../../../src/lib/reports/linkProgress.js';
import { buildMonthReports } from '../../../src/lib/reports/monthReports.js';
import {
  OrganizerTokenUnavailableError,
  withOrganizerMeetup,
} from '../../../src/lib/reports/organizerMeetup.js';
import { Period } from '../../../src/lib/reports/period.js';
import { REPORT_TYPES } from '../../../src/lib/reports/types.js';
import { PostgresDashboardNoticeRepository } from '../../../src/lib/repositories/postgresDashboardNoticeRepository.js';
import { PostgresLinkProgressRepository } from '../../../src/lib/repositories/postgresLinkProgressRepository.js';
import { PostgresReportSnapshotRepository } from '../../../src/lib/repositories/postgresReportSnapshotRepository.js';
import { PostgresSuspensionRepository } from '../../../src/lib/repositories/postgresSuspensionRepository.js';
import { FakeCache } from '../../web/fakeCache.js';
import {
  Clock,
  FakeLinkProgressStore,
  FakeNoticeStore,
  FakeSnapshotStore,
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
  postRoleNotice: vi.fn(),
}));
vi.mock(
  '../../../src/lib/repositories/postgresReportSnapshotRepository.js',
  () => ({ PostgresReportSnapshotRepository: { instance: vi.fn() } }),
);
vi.mock(
  '../../../src/lib/repositories/postgresDashboardNoticeRepository.js',
  () => ({ PostgresDashboardNoticeRepository: { instance: vi.fn() } }),
);
vi.mock(
  '../../../src/lib/repositories/postgresLinkProgressRepository.js',
  () => ({ PostgresLinkProgressRepository: { instance: vi.fn() } }),
);
vi.mock(
  '../../../src/lib/repositories/postgresSuspensionRepository.js',
  () => ({ PostgresSuspensionRepository: { instance: vi.fn() } }),
);

const SEPT: Period = { year: 2026, month: 9 };
const OCT: Period = { year: 2026, month: 10 };
const LEASE_KEY = 'report-build-claim';
const MOD = '912474048775221270';
const LEADERSHIP = '1347289004932075521';
const REQUESTER = '123456789012345678';

const isSept = (p: Period) => p.year === 2026 && p.month === 9;
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
    await (result as { done: Promise<void> }).done;
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
    expect(titles(h.alert)).toEqual(['Reports built: September 2026']);
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

    h.clock.set('2026-10-05T16:30:00Z');
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
    expect(JSON.stringify(h.postRoleNotice.mock.calls)).not.toContain(SENTINEL);
  });

  it('an organizer-login failure shows its own message', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockRejectedValue(new OrganizerTokenUnavailableError());
    await runBuildTick(h.deps);
    expect(descriptions(h.alert)[0]).toContain('/dashboard/organizer-login');
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

    h.clock.set('2026-10-05T16:30:00Z');
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

    h.clock.set('2026-10-05T16:30:00Z');
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
    h.clock.set('2026-10-05T16:30:00Z');
    await runBuildTick(h.deps);
    expect(h.cache.values.has('report-build-failing-2026-09')).toBe(true);
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
    expect(titles(h.alert)).toEqual(['Reports built: September 2026']);
    expect(descriptions(h.alert)[0]).toContain(
      'Note: no no-shows recorded for September 2026 across 6 past events with RSVPs; check that attendance was taken.',
    );
    const noShowSave = h.snapshots.rows.find(
      (r) => r.reportType === 'no_show' && isSept(r.period),
    );
    expect(noShowSave.sourceComplete).toBe(true);
    expect(h.postRoleNotice).toHaveBeenCalledTimes(1);
  });

  it('no note for an open month with no no-shows', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockImplementation((period) =>
      Promise.resolve(monthReports(period, ZERO)),
    );
    const result = await requestRebuild(h.deps, OCT, REQUESTER);
    await (result as { done: Promise<void> }).done;
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
    expect(titles(h.alert)).toEqual(['Reports built: September 2026']);
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

  it('is off in this PR', () => {
    expect(REPORT_READY_ENABLED).toBe(false);
  });

  it('report-ready mentions both roles in content with allowedMentions limited to them', async () => {
    const h = settled();
    await runBuildTick(h.deps);
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(h.postRoleNotice).toHaveBeenCalledTimes(1);
    const [roleIds, content, entry] = h.postRoleNotice.mock.calls[0];
    expect(roleIds).toEqual([MOD, LEADERSHIP]);
    expect(REPORT_READY_ROLE_IDS).toEqual([
      SERVER_ROLES.moderator,
      SERVER_ROLES.leadership,
    ]);
    expect(content).toContain(`<@&${MOD}>`);
    expect(content).toContain(`<@&${LEADERSHIP}>`);
    expect(content).toContain(
      '<https://meetup-discord-bot.herokuapp.com/dashboard/no-shows/2026-09>',
    );
    expect(reportMonthUrl(SEPT)).toBe(
      'https://meetup-discord-bot.herokuapp.com/dashboard/no-shows/2026-09',
    );
    expect(entry.title).toBe('Reports ready: September 2026');
    expect(entry.description).toContain(
      'No-shows: 2 warnings, 3 suspension candidates.',
    );
    expect(entry.description).toContain(
      'Hall of Fame: 4 events, 3 hosts (1 new).',
    );
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('report-ready posts once per period across restarts', async () => {
    const notices = new FakeNoticeStore();
    const snapshots = new FakeSnapshotStore();
    snapshots.seedBoth(SEPT, '2026-10-03T16:10:00Z');
    snapshots.seedBoth(OCT, '2026-10-10T16:05:00Z');
    const first = settled({ notices, snapshots });
    await runBuildTick(first.deps);
    const second = settled({ notices, snapshots, cache: new FakeCache() });
    second.clock.set('2026-10-10T16:30:00Z');
    await runBuildTick(second.deps);
    expect(
      first.postRoleNotice.mock.calls.length +
        second.postRoleNotice.mock.calls.length,
    ).toBe(1);
  });

  it('report-ready for the latest finished month even when the backfill built it', async () => {
    const snapshots = new FakeSnapshotStore();
    snapshots.seedBoth(SEPT, '2026-10-03T16:10:00Z', { builtBy: 'backfill' });
    snapshots.seedBoth(OCT, '2026-10-10T16:05:00Z');
    const h = settled({ snapshots });
    await runBuildTick(h.deps);
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(h.postRoleNotice).toHaveBeenCalledTimes(1);
  });

  it('report-ready waits for a build made after the month ended', async () => {
    const h = makeDeps({ clock: new Clock('2026-10-01T16:15:00Z') });
    h.snapshots.seedBoth(SEPT, '2026-09-30T16:10:00Z');
    await runBuildTick(h.deps);
    expect(fetchedPeriods(h)).toEqual(['2026-10']); // no previous-month build on the 1st
    expect(h.notices.claim).not.toHaveBeenCalled();
    expect(h.postRoleNotice).not.toHaveBeenCalled();
  });

  it('report-ready waits for both rows', async () => {
    const snapshots = new FakeSnapshotStore();
    snapshots.seed('hall_of_fame', SEPT, '2026-10-03T16:10:00Z');
    snapshots.seed('no_show', SEPT, '2026-09-30T16:10:00Z');
    const h = settled({ snapshots });
    expect(await maybePostReportReady(h.deps)).toBe('skipped');
    expect(h.postRoleNotice).not.toHaveBeenCalled();
  });

  it('failed report-ready post is retried', async () => {
    const h = settled();
    h.postRoleNotice.mockResolvedValueOnce(false);
    await runBuildTick(h.deps);
    expect(h.notices.release).toHaveBeenCalledWith('report_ready', SEPT);
    expect(h.notices.markers.size).toBe(0);

    h.clock.set('2026-10-10T16:30:00Z');
    await runBuildTick(h.deps);
    expect(h.postRoleNotice).toHaveBeenCalledTimes(2);
    expect(h.notices.markers.has('report_ready:2026-09')).toBe(true);
  });

  it('claim and release go to the same notice store', async () => {
    const h = settled();
    h.postRoleNotice.mockResolvedValueOnce(false);
    expect(await maybePostReportReady(h.deps)).toBe('failed');
    expect(h.notices.claim).toHaveBeenCalledTimes(1);
    expect(h.notices.release).toHaveBeenCalledTimes(1);
  });

  it('report-ready is off while REPORT_READY_ENABLED is false', async () => {
    const h = settled({ reportReadyEnabled: false });
    await runBuildTick(h.deps);
    expect(h.notices.claim).not.toHaveBeenCalled();
    expect(h.postRoleNotice).not.toHaveBeenCalled();
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
    await (result as { done: Promise<void> }).done;
    expect(h.snapshots.rows.map((r) => r.builtBy)).toEqual([
      REQUESTER,
      REQUESTER,
    ]);
    expect(titles(h.alert)).toEqual(['Reports built: September 2026']);
    expect(descriptions(h.alert)[0]).toContain(`<@${REQUESTER}>`);
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
    expect(h.postRoleNotice).not.toHaveBeenCalled(); // manual rebuilds never post report-ready
  });

  it('a failed manual rebuild alerts and releases the lease', async () => {
    const h = makeDeps();
    h.fetchMonthReports.mockRejectedValue(new Error('boom'));
    const result = await requestRebuild(h.deps, SEPT, REQUESTER);
    await expect(
      (result as { done: Promise<void> }).done,
    ).resolves.toBeUndefined();
    expect(titles(h.alert)).toEqual(['Report build failed: September 2026']);
    expect(h.cache.values.has(LEASE_KEY)).toBe(false);
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
    expect(deps.snapshots).toBe(snapshots);
    expect(deps.notices).toBe(notices);
    expect(deps.linkProgress).toBe(linkProgress);
    expect(deps.reportReadyEnabled()).toBe(false);

    const asOf = new Date('2026-10-01T07:00:00Z');
    const cutoff = new Date('2026-10-01T00:00:00Z');
    expect(await deps.fetchMonthReports(SEPT, asOf, cutoff)).toBe(reports);
    expect(withOrganizerMeetup).toHaveBeenCalledWith(
      client,
      expect.any(Function),
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
    await deps.postRoleNotice(REPORT_READY_ROLE_IDS, 'c', entry);
    expect(postRoleNotice).toHaveBeenCalledWith(
      client,
      BOT_ALERTS_CHANNEL_ID,
      [MOD, LEADERSHIP],
      'c',
      entry,
    );
    await deps.collectLinkProgress();
    expect(collectLinkProgress).toHaveBeenCalledWith(client);
    expect(deps.newLeaseValue()).not.toBe(deps.newLeaseValue());
    expect(deps.newLeaseValue()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('fake store sanity', () => {
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

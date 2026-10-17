import { ClientError } from 'graphql-request';
import { describe, expect, it, vi } from 'vitest';

import { KeyValueCache } from '../../../src/lib/cache/base.js';
import { LogEntry } from '../../../src/lib/helpers/discordLogger.js';
import { identityDigestClaimKey } from '../../../src/lib/helpers/identity/digest.js';
import {
  BACKFILL_DEFAULT_FROM,
  BACKFILL_LEASE_POLL_MS,
  BACKFILL_LEASE_WAIT_MS,
  BackfillOptions,
  BACKFILL_MAX_CONSECUTIVE_FAILURES,
  BACKFILL_RUN_LOCK_KEY,
  BACKFILL_RUN_LOCK_TTL_SEC,
  BACKFILL_STOP_TEXT,
  BackfillRefusedError,
  BackfillResult,
  backfillFinalEntry,
  backfillMonths,
  runBackfill,
} from '../../../src/lib/reports/backfill.js';
import {
  buildMonth,
  requestRebuild,
} from '../../../src/lib/reports/buildJob.js';
import { BUILD_LEASE_KEY } from '../../../src/lib/reports/buildLease.js';
import { OrganizerTokenUnavailableError } from '../../../src/lib/reports/organizerMeetup.js';
import {
  GROUP_FIRST_PERIOD,
  monthLabel,
  Period,
  periodEnd,
  periodKey,
  suspensionCutoff,
} from '../../../src/lib/reports/period.js';
import {
  Clock,
  ExpiringCache,
  makeDeps,
  monthReports,
} from './buildJobFakes.js';
import { timedCache } from '../../../src/web/timedCache.js';

// The real buildMonth, wrapped so its options can be inspected.
vi.mock('../../../src/lib/reports/buildJob.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/lib/reports/buildJob.js')
    >();
  return { ...actual, buildMonth: vi.fn(actual.buildMonth) };
});

const FROM: Period = { year: 2025, month: 9 };
const key = (p: Period) => periodKey(p);

function harness(
  iso = '2026-10-16T19:30:00Z',
  wrapCache: (inner: KeyValueCache) => KeyValueCache = (inner) => inner,
) {
  const clock = new Clock(iso);
  const h = makeDeps({ clock });
  const cache = h.cache as ExpiringCache;
  const post = vi.fn((_entry: LogEntry) => Promise.resolve(true));
  const sleep = vi.fn((ms: number) => {
    clock.set(new Date(clock.now().getTime() + ms).toISOString());
    return Promise.resolve();
  });
  let leases = 0;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const stop = { requested: false };
  const deps = {
    now: () => clock.now(),
    cache: () => Promise.resolve(wrapCache(cache)),
    stopRequested: () => stop.requested,
    build: h.deps,
    post,
    sleep,
    newLeaseValue: () => {
      leases += 1;
      return `backfill-${leases}`;
    },
    log,
  };
  const run = (options: Partial<BackfillOptions> = {}) =>
    runBackfill(deps, {
      force: false,
      from: FROM,
      delayMs: 0,
      leaseWaitMs: BACKFILL_LEASE_WAIT_MS,
      allowAllDeparted: false,
      ...options,
    });
  const leaseCount = () => leases;
  const titles = () => post.mock.calls.map(([e]) => e.title);
  const finalText = () =>
    post.mock.calls[post.mock.calls.length - 1][0].description ?? '';
  const fetched = () => h.fetchMonthReports.mock.calls.map(([p]) => key(p));
  const savedMonths = () => [
    ...new Set(h.snapshots.rows.map((r) => key(r.period))),
  ];
  return {
    ...h,
    clock,
    cache,
    post,
    sleep,
    log,
    deps,
    run,
    titles,
    finalText,
    leaseCount,
    stop,
    fetched,
    savedMonths,
  };
}

/** A month whose no-show summary has `members` members, `departed` of them gone. */
function withMembers(target: Period, members: number, departed: number) {
  return (period: Period) => {
    const reports = monthReports(period);
    if (key(period) === key(target)) {
      reports.noShow.summary.members = members;
      reports.noShow.summary.departed = departed;
    }
    return Promise.resolve(reports);
  };
}

describe('backfillMonths', () => {
  it('lists finished months newest first, down to the first', () => {
    expect(
      backfillMonths(FROM, new Date('2026-10-16T19:30:00Z')).map(key),
    ).toEqual([
      '2026-09',
      '2026-08',
      '2026-07',
      '2026-06',
      '2026-05',
      '2026-04',
      '2026-03',
      '2026-02',
      '2026-01',
      '2025-12',
      '2025-11',
      '2025-10',
      '2025-09',
    ]);
  });
});

describe('start month', () => {
  it('defaults to the group first month, 2013-03', async () => {
    expect(BACKFILL_DEFAULT_FROM).toEqual({ year: 2013, month: 3 });
    expect(BACKFILL_DEFAULT_FROM).toBe(GROUP_FIRST_PERIOD);
    const h = harness();
    const result = await h.run({ from: undefined });
    // 2013-03 to 2026-09 inclusive.
    expect(result.months).toBe(163);
    expect(h.fetched()[0]).toBe('2026-09');
    expect(h.fetched()[h.fetched().length - 1]).toBe('2013-03');
    expect(h.fetched()).not.toContain('2013-02');
    expect(h.post.mock.calls[0][0].description).toContain(
      '163 months, September 2026 back to March 2013.',
    );
  });

  it('--from overrides it', async () => {
    const h = harness();
    const result = await h.run({ from: { year: 2026, month: 6 } });
    expect(result.months).toBe(4);
    expect(h.fetched()).toEqual(['2026-09', '2026-08', '2026-07', '2026-06']);
  });

  it('refuses a --from before the group began', async () => {
    const h = harness();
    await expect(h.run({ from: { year: 2013, month: 2 } })).rejects.toEqual(
      new BackfillRefusedError('before-group'),
    );
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });
});

describe('time window', () => {
  it('refuses to start 17:45-19:00 UTC', async () => {
    for (const iso of [
      '2026-10-16T17:45:00Z',
      '2026-10-16T18:00:00Z',
      '2026-10-16T18:59:00Z',
    ]) {
      const h = harness(iso);
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      await expect(h.run()).rejects.toEqual(
        new BackfillRefusedError('quiet-window'),
      );
      expect(h.fetchMonthReports).not.toHaveBeenCalled();
      expect(h.post).not.toHaveBeenCalled();
    }
    for (const iso of ['2026-10-16T17:44:00Z', '2026-10-16T19:00:00Z']) {
      const h = harness(iso);
      // eslint-disable-next-line no-await-in-loop -- one case at a time
      const result = await h.run();
      expect(result.built).toHaveLength(13);
      expect(result.stopped).toBeUndefined();
    }
  });

  it('stops before the next month when the window opens mid-run', async () => {
    const h = harness('2026-10-16T17:00:00Z');
    h.fetchMonthReports.mockImplementation((period) => {
      h.clock.set(
        new Date(h.clock.now().getTime() + 20 * 60_000).toISOString(),
      );
      return Promise.resolve(monthReports(period));
    });
    const result = await h.run();
    // 17:00, 17:20 and 17:40 start; the month that would start at 18:00 does not.
    expect(h.fetched()).toEqual(['2026-09', '2026-08', '2026-07']);
    // Checked before the lease too: no lease is taken inside the window.
    // One value for the run lock, then one lease per month started.
    expect(h.leaseCount()).toBe(4);
    expect(result.stopped).toBe('quiet-window');
    expect(h.titles()).toEqual([
      'Report backfill started',
      'Report backfill stopped',
    ]);
    expect(h.finalText()).toContain('Run it again after 19:00 UTC');
    expect(h.cache.values.has(BUILD_LEASE_KEY)).toBe(false);
  });

  it('lease wait crosses 17:45: stops without building', async () => {
    const h = harness('2026-10-16T17:40:00Z');
    // Another build holds the lease until 17:50.
    await h.cache.set(BUILD_LEASE_KEY, 'job-lease', 10 * 60);
    const result = await h.run();
    expect(h.sleep).toHaveBeenCalledWith(BACKFILL_LEASE_POLL_MS);
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(result.stopped).toBe('quiet-window');
    expect(h.cache.values.has(BUILD_LEASE_KEY)).toBe(false);
  });

  it('refuses to start while the identity digest is running', async () => {
    const h = harness();
    await h.cache.set(identityDigestClaimKey('2026-10-16'), '1');
    await expect(h.run()).rejects.toEqual(
      new BackfillRefusedError('identity-sweep'),
    );
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
  });

  it('stops while the identity digest is running', async () => {
    const h = harness();
    h.fetchMonthReports.mockImplementationOnce(async (period) => {
      // Claimed without its done marker: a digest is running.
      await h.cache.set(identityDigestClaimKey('2026-10-16'), '1');
      return monthReports(period);
    });
    const result = await h.run();
    expect(result.built.map(key)).toEqual(['2026-09']);
    expect(result.stopped).toBe('identity-sweep');
    expect(h.finalText()).toContain('Stopped while the identity sweep runs.');
  });

  it('stops when Redis stops answering', async () => {
    const h = harness();
    h.fetchMonthReports.mockImplementationOnce((period) => {
      vi.spyOn(h.cache, 'get').mockRejectedValue(new Error('redis down'));
      return Promise.resolve(monthReports(period));
    });
    const result = await h.run();
    expect(result.stopped).toBe('cache-unavailable');
    expect(h.titles()[h.titles().length - 1]).toBe('Report backfill stopped');
  });
});

describe('builds', () => {
  it('builds newest first with builtBy backfill', async () => {
    const h = harness();
    const result = await h.run();
    expect(h.fetched()).toEqual(backfillMonths(FROM, h.clock.now()).map(key));
    expect(result.built).toHaveLength(13);
    expect(h.snapshots.rows).toHaveLength(26);
    for (const row of h.snapshots.rows) {
      expect(row.builtBy).toBe('backfill');
      expect(row.mode).toBe('supersede');
    }
    const [period, asOf, cutoff] = h.fetchMonthReports.mock.calls[3];
    expect(key(period)).toBe('2026-06');
    expect(asOf).toEqual(periodEnd(period));
    expect(cutoff).toEqual(suspensionCutoff(period));
  });

  it('skips months with a finished snapshot unless --force', async () => {
    const h = harness();
    const AUG = { year: 2026, month: 8 };
    const JUL = { year: 2026, month: 7 };
    h.snapshots.seedBoth(AUG, '2026-09-02T16:00:00Z');
    h.snapshots.seedBoth(JUL, '2026-07-20T16:00:00Z'); // an open-month build
    const result = await h.run();
    expect(result.skipped.map(key)).toEqual(['2026-08']);
    expect(h.fetched()).not.toContain('2026-08');
    expect(h.fetched()).toContain('2026-07');

    const forced = harness();
    forced.snapshots.seedBoth(AUG, '2026-09-02T16:00:00Z');
    const again = await forced.run({ force: true });
    expect(again.skipped).toEqual([]);
    expect(forced.fetched()).toContain('2026-08');
    expect(forced.post.mock.calls[0][0].description).toContain('(--force)');
  });

  it('posts progress every 12 months processed', async () => {
    const h = harness();
    h.snapshots.seedBoth({ year: 2026, month: 8 }, '2026-09-02T16:00:00Z');
    await h.run();
    expect(h.titles()).toEqual([
      'Report backfill started',
      'Report backfill progress',
      'Report backfill finished',
    ]);
    expect(h.post.mock.calls[1][0].description).toBe(
      '12 of 13 months processed: 11 built, 1 already built, 0 failed. Latest: October 2025.',
    );
    expect(h.finalText()).toContain(
      '13 months: 12 built, 1 already built, 0 failed.',
    );
  });

  it('posts carry no mentions and no member data', async () => {
    const h = harness();
    await h.run();
    for (const [entry] of h.post.mock.calls) {
      expect(Object.keys(entry).sort()).toEqual(['description', 'title']);
      expect(entry.description).not.toMatch(/<@|@everyone|@here/);
    }
  });

  it('failure text uses describeBuildError and the run continues', async () => {
    const h = harness();
    const secret = new ClientError(
      { status: 500, body: 'SECRET_BODY' } as never,
      {
        query: '',
      },
    );
    h.fetchMonthReports.mockImplementation((period) => {
      if (key(period) === '2026-06') {
        return Promise.reject(secret);
      }
      return Promise.resolve(monthReports(period));
    });
    const result = await h.run();
    expect(result.failed).toEqual([
      {
        period: { year: 2026, month: 6 },
        reason: 'Meetup API error (HTTP 500)',
        allDepartedRefusal: false,
      },
    ]);
    expect(h.finalText()).toContain('June 2026: Meetup API error (HTTP 500)');
    for (const [entry] of h.post.mock.calls) {
      expect(JSON.stringify(entry)).not.toContain('SECRET_BODY');
    }
    expect(h.fetched()).toContain('2026-05');
    expect(result.built).toHaveLength(12);
  });

  it('a failed post never stops the run', async () => {
    const h = harness();
    h.post
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('discord down'));
    const result = await h.run();
    expect(result.built).toHaveLength(13);
    expect(h.post).toHaveBeenCalledTimes(3);
  });

  it('sleeps delayMs between months read from Meetup, not after skipped ones', async () => {
    const h = harness();
    h.snapshots.seedBoth({ year: 2026, month: 8 }, '2026-09-02T16:00:00Z');
    await h.run({ from: { year: 2026, month: 7 }, delayMs: 5000 });
    // After September (built); not after August (skipped) or July (the last).
    expect(h.sleep.mock.calls).toEqual([[5000]]);
  });
});

describe('no-show members', () => {
  it('a zero-no-show month is saved and counted, never refused or listed', async () => {
    const h = harness();
    const MAY = { year: 2026, month: 5 };
    h.fetchMonthReports.mockImplementation(withMembers(MAY, 0, 0));
    const result = await h.run();
    expect(result.failed).toEqual([]);
    expect(result.noNoShows).toBe(1);
    expect(result.allDeparted).toEqual([]);
    expect(h.savedMonths()).toContain('2026-05');
    expect(h.finalText()).toContain(
      '1 month had no no-shows recorded (saved normally).',
    );
    expect(h.finalText()).not.toContain('May 2026');
  });

  it('an all-departed month (3+) is reported, not saved, and the run continues', async () => {
    const h = harness();
    const MAR = { year: 2026, month: 3 };
    h.fetchMonthReports.mockImplementation(withMembers(MAR, 4, 4));
    const result = await h.run();
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].allDepartedRefusal).toBe(true);
    expect(h.savedMonths()).not.toContain('2026-03');
    expect(h.savedMonths()).toContain('2026-02');
    expect(result.built).toHaveLength(12);
    expect(h.finalText()).toContain('has left the group: March 2026.');
    expect(h.finalText()).toContain('--allow-all-departed --from 2026-03');
    // Its long guard text is not repeated as a failure line.
    expect(h.finalText()).not.toContain('Failed:');
  });

  it('allowAllDeparted is passed only with the flag', async () => {
    const MAR = { year: 2026, month: 3 };
    vi.mocked(buildMonth).mockClear();
    const without = harness();
    without.fetchMonthReports.mockImplementation(withMembers(MAR, 4, 4));
    await without.run();
    expect(vi.mocked(buildMonth).mock.calls.length).toBe(13);
    for (const call of vi.mocked(buildMonth).mock.calls) {
      expect(call[2]).toBe('backfill');
      expect(call[3]).toEqual({});
    }

    vi.mocked(buildMonth).mockClear();
    const withFlag = harness();
    withFlag.fetchMonthReports.mockImplementation(withMembers(MAR, 4, 4));
    const result = await withFlag.run({ allowAllDeparted: true });
    for (const call of vi.mocked(buildMonth).mock.calls) {
      expect(call[3]).toEqual({ allowAllDeparted: true });
    }
    expect(result.failed).toEqual([]);
    expect(result.allDeparted.map(key)).toEqual(['2026-03']);
    expect(withFlag.savedMonths()).toContain('2026-03');
    expect(withFlag.finalText()).toContain(
      'Saved with every no-show member gone from the group: March 2026.',
    );
    expect(withFlag.post.mock.calls[0][0].description).toContain(
      '(--allow-all-departed)',
    );
  });

  it('a month with 1-2 members all departed is saved with the note, without the flag', async () => {
    const h = harness();
    const MAR = { year: 2026, month: 3 };
    h.fetchMonthReports.mockImplementation(withMembers(MAR, 2, 2));
    const result = await h.run();
    expect(result.failed).toEqual([]);
    expect(result.allDeparted.map(key)).toEqual(['2026-03']);
    expect(h.savedMonths()).toContain('2026-03');
  });
});

describe('build lease', () => {
  it('takes the build lease per month and releases it', async () => {
    const h = harness();
    const held: (string | undefined)[] = [];
    h.fetchMonthReports.mockImplementation((period) => {
      held.push(h.cache.values.get(BUILD_LEASE_KEY));
      return Promise.resolve(monthReports(period));
    });
    await h.run({ from: { year: 2026, month: 7 } });
    // backfill-1 is the run lock's value.
    expect(held).toEqual(['backfill-2', 'backfill-3', 'backfill-4']);
    expect(h.cache.values.has(BUILD_LEASE_KEY)).toBe(false);
  });

  it('releases the lease when a month fails', async () => {
    const h = harness();
    h.fetchMonthReports.mockRejectedValue(new Error('boom'));
    await h.run({ from: { year: 2026, month: 9 } });
    expect(h.cache.values.has(BUILD_LEASE_KEY)).toBe(false);
  });

  it('waits while another build holds the lease', async () => {
    const h = harness();
    await h.cache.set(BUILD_LEASE_KEY, 'job-lease', 5 * 60);
    const result = await h.run({ from: { year: 2026, month: 9 } });
    expect(h.sleep.mock.calls).toEqual(
      Array.from({ length: (5 * 60_000) / BACKFILL_LEASE_POLL_MS }, () => [
        BACKFILL_LEASE_POLL_MS,
      ]),
    );
    expect(result.built.map(key)).toEqual(['2026-09']);
  });

  it('gives up after 20 minutes of waiting', async () => {
    const h = harness();
    await h.cache.set(BUILD_LEASE_KEY, 'stuck'); // never expires
    const result = await h.run();
    expect(result.stopped).toBe('lease-timeout');
    expect(h.sleep).toHaveBeenCalledTimes(
      BACKFILL_LEASE_WAIT_MS / BACKFILL_LEASE_POLL_MS,
    );
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(h.finalText()).toContain('held the build lease for over 20 minutes');
    expect(h.cache.values.get(BUILD_LEASE_KEY)).toBe('stuck');
  });

  it("the job's refresh is refused while the backfill builds a month", async () => {
    const h = harness();
    const statuses: string[] = [];
    h.fetchMonthReports.mockImplementationOnce(async (period) => {
      statuses.push(
        // The build job's own deps (the same cache and clock).
        (
          await requestRebuild(
            h.deps.build,
            { year: 2026, month: 9 },
            '123456789012345678',
          )
        ).status,
      );
      return monthReports(period);
    });
    await h.run({ from: { year: 2026, month: 9 } });
    expect(statuses).toEqual(['busy']);
  });
});

const clientError = (status: number) =>
  new ClientError({ status, body: 'SECRET_BODY' } as never, { query: '' });

describe('circuit breaker', () => {
  for (const [name, error] of [
    ['a 429', clientError(429)],
    ['a 401', clientError(401)],
    ['no usable organizer token', new OrganizerTokenUnavailableError()],
  ] as const) {
    it(`${name} stops the run at once`, async () => {
      const h = harness();
      h.fetchMonthReports.mockRejectedValue(error);
      const result = await h.run();
      expect(h.fetched()).toEqual(['2026-09']);
      expect(result.stopped).toBe('meetup-unavailable');
      expect(h.cache.values.has(BUILD_LEASE_KEY)).toBe(false);
      expect(h.titles()[h.titles().length - 1]).toBe('Report backfill stopped');
      expect(
        h.finalText().startsWith(BACKFILL_STOP_TEXT['meetup-unavailable']),
      ).toBe(true);
      expect(h.finalText()).not.toContain('SECRET_BODY');
    });
  }

  it('the organizer reason points at the renewal page, not an alert the backfill never posts', async () => {
    const h = harness();
    h.fetchMonthReports.mockRejectedValue(new OrganizerTokenUnavailableError());
    const result = await h.run();
    expect(result.failed[0].reason).toBe(
      'No usable Meetup organizer login; it may need renewing at https://meetup-discord-bot.herokuapp.com/dashboard/organizer-login.',
    );
    expect(h.finalText()).not.toContain('organizer login alert');
  });

  it(`${BACKFILL_MAX_CONSECUTIVE_FAILURES} failed months in a row stop the run`, async () => {
    expect(BACKFILL_MAX_CONSECUTIVE_FAILURES).toBe(3);
    const h = harness();
    h.fetchMonthReports.mockRejectedValue(clientError(500));
    const result = await h.run();
    expect(h.fetched()).toEqual(['2026-09', '2026-08', '2026-07']);
    expect(result.stopped).toBe('repeated-failures');
    expect(
      h.finalText().startsWith(BACKFILL_STOP_TEXT['repeated-failures']),
    ).toBe(true);
  });

  it('a built month resets the count', async () => {
    const h = harness();
    // Fail, fail, build, fail, fail, build, ...
    h.fetchMonthReports.mockImplementation((period) => {
      if (h.fetchMonthReports.mock.calls.length % 3 === 0) {
        return Promise.resolve(monthReports(period));
      }
      return Promise.reject(clientError(500));
    });
    const result = await h.run();
    expect(result.stopped).toBeUndefined();
    expect(h.fetched()).toHaveLength(13);
  });

  it('all-departed refusals do not count as failures', async () => {
    const h = harness();
    h.fetchMonthReports.mockImplementation((period) => {
      const reports = monthReports(period);
      reports.noShow.summary.members = 4;
      reports.noShow.summary.departed = 4;
      return Promise.resolve(reports);
    });
    const result = await h.run();
    expect(result.stopped).toBeUndefined();
    expect(result.failed).toHaveLength(13);
    expect(result.failed.every((f) => f.allDepartedRefusal)).toBe(true);
  });

  it('an unreadable snapshot store stops after 3 months, without reading Meetup', async () => {
    const h = harness();
    vi.spyOn(h.snapshots, 'getCurrentMeta').mockRejectedValue(
      new Error('pg down'),
    );
    const result = await h.run();
    expect(result.stopped).toBe('repeated-failures');
    expect(result.failed).toHaveLength(3);
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
  });
});

describe('final post', () => {
  const MONTHS = backfillMonths(
    { year: 2013, month: 3 },
    new Date('2026-10-16T19:30:00Z'),
  );
  const base = (over: Partial<BackfillResult>): BackfillResult => ({
    months: MONTHS.length,
    built: [],
    skipped: [],
    failed: [],
    allDeparted: [],
    noNoShows: 0,
    ...over,
  });

  it('keeps the stop text and the --allow-all-departed hint within 4000 characters', () => {
    const failed = MONTHS.slice(0, 20).map((period, i) => ({
      period,
      reason: `Reason ${i} ${'x'.repeat(400)}`,
      allDepartedRefusal: false,
    }));
    const refused = MONTHS.slice(20, 60).map((period) => ({
      period,
      reason: 'refused',
      allDepartedRefusal: true,
    }));
    const entry = backfillFinalEntry(
      base({
        failed: [...failed, ...refused],
        stopped: 'quiet-window',
        noNoShows: 40,
      }),
    );
    const text = entry.description ?? '';
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text.startsWith(BACKFILL_STOP_TEXT['quiet-window'])).toBe(true);
    expect(text).toContain(
      `--allow-all-departed --from ${periodKey(MONTHS[59])}`,
    );
    expect(text.indexOf('--allow-all-departed')).toBeLessThan(
      text.indexOf('Failed:'),
    );
    // Each reason is capped.
    for (const line of text.split('\n').filter((l) => l.includes('Reason '))) {
      expect(line.length).toBeLessThanOrEqual(230);
    }
  });

  it('collapses identical reasons into one line', () => {
    const failed = MONTHS.slice(0, 143).map((period) => ({
      period,
      reason: 'Meetup API error (HTTP 500)',
      allDepartedRefusal: false,
    }));
    failed.push({
      period: MONTHS[150],
      reason: 'Other',
      allDepartedRefusal: false,
    });
    const text = backfillFinalEntry(base({ failed })).description ?? '';
    expect(text).toContain('143 months: Meetup API error (HTTP 500)');
    expect(text).toContain(`${monthLabel(MONTHS[150])}: Other`);
    expect(text.split('\n').filter((l) => l.includes('HTTP 500'))).toHaveLength(
      1,
    );
  });
});

describe('stop requests (SIGTERM)', () => {
  it('finishes the current month, releases its lease, then stops', async () => {
    const h = harness();
    h.fetchMonthReports.mockImplementation((period) => {
      if (h.fetchMonthReports.mock.calls.length === 2) {
        h.stop.requested = true; // the signal arrives mid-build
      }
      return Promise.resolve(monthReports(period));
    });
    const result = await h.run();
    expect(result.built.map(key)).toEqual(['2026-09', '2026-08']);
    expect(h.savedMonths()).toEqual(['2026-09', '2026-08']);
    expect(result.stopped).toBe('stopped');
    expect(h.cache.values.has(BUILD_LEASE_KEY)).toBe(false);
    expect(h.titles()[h.titles().length - 1]).toBe('Report backfill stopped');
    expect(h.finalText().startsWith(BACKFILL_STOP_TEXT.stopped)).toBe(true);
  });

  it('stops while waiting for the lease', async () => {
    const h = harness();
    await h.cache.set(BUILD_LEASE_KEY, 'job-lease');
    h.sleep.mockImplementation((ms) => {
      h.stop.requested = true;
      h.clock.set(new Date(h.clock.now().getTime() + ms).toISOString());
      return Promise.resolve();
    });
    const result = await h.run();
    expect(result.stopped).toBe('stopped');
    // One step of at most 5 s: well inside Heroku's 30 s before SIGKILL.
    expect(h.sleep.mock.calls).toEqual([[BACKFILL_LEASE_POLL_MS]]);
    expect(BACKFILL_LEASE_POLL_MS).toBeLessThanOrEqual(5_000);
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(h.titles()[h.titles().length - 1]).toBe('Report backfill stopped');
  });

  it('the stop text names the signal, not a deploy', () => {
    expect(BACKFILL_STOP_TEXT.stopped).toBe(
      'The run was asked to stop (SIGTERM or Ctrl-C). Re-run the same command to continue; months already built are skipped.',
    );
  });
});

describe('Redis timeouts', () => {
  /** get hangs once `down` is set, as node-redis does while offline. */
  const hanging = (down: { now: boolean }) => (inner: KeyValueCache) =>
    timedCache(
      {
        get: (k: string) => {
          if (down.now) {
            return new Promise<undefined>(() => undefined);
          }
          return inner.get(k);
        },
        set: (k: string, v: string, t?: number) => inner.set(k, v, t),
        exclusive_set: (k: string, v: string, t?: number) =>
          inner.exclusive_set(k, v, t),
        set_existing: (k: string, v: string, t?: number) =>
          inner.set_existing(k, v, t),
        remove: (k: string) => inner.remove(k),
      },
      20,
    );

  it('an outage mid-run stops it as cache-unavailable', async () => {
    const down = { now: false };
    const h = harness(undefined, hanging(down));
    h.fetchMonthReports.mockImplementationOnce((period) => {
      down.now = true;
      return Promise.resolve(monthReports(period));
    });
    const result = await h.run();
    expect(result.built.map(key)).toEqual(['2026-09']);
    expect(result.stopped).toBe('cache-unavailable');
    expect(
      h.finalText().startsWith(BACKFILL_STOP_TEXT['cache-unavailable']),
    ).toBe(true);
  });

  it('an outage at the start refuses as cache-unavailable', async () => {
    const h = harness(undefined, hanging({ now: true }));
    await expect(h.run()).rejects.toEqual(
      new BackfillRefusedError('cache-unavailable'),
    );
    expect(h.post).not.toHaveBeenCalled();
  });
});

describe('process log', () => {
  it('logs the error class and describeBuildError text, never the Meetup body', async () => {
    const h = harness();
    h.fetchMonthReports.mockRejectedValueOnce(clientError(500));
    await h.run({ from: { year: 2026, month: 9 } });
    const lines = h.log.error.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain(
      'Backfill 2026-09 failed: ClientError: Meetup API error (HTTP 500)',
    );
    expect(lines.join('\n')).not.toContain('SECRET_BODY');
  });
});

describe('the --allow-all-departed hint', () => {
  const refused = (period: Period) => ({
    period,
    reason: 'refused',
    allDepartedRefusal: true,
  });
  const result = (stopped?: BackfillResult['stopped']): BackfillResult => ({
    months: 13,
    built: [],
    skipped: [],
    failed: [refused({ year: 2026, month: 3 })],
    allDeparted: [],
    noNoShows: 0,
    stopped,
  });

  it('after a full run, suggests the flag', () => {
    const text = backfillFinalEntry(result()).description ?? '';
    expect(text).toContain('--allow-all-departed --from 2026-03');
    expect(text).not.toContain('Only after a run finishes');
  });

  it('after an early stop, says to wait for a run that finishes', () => {
    const text = backfillFinalEntry(result('quiet-window')).description ?? '';
    expect(text).toContain(
      'Only after a run finishes without stopping (this one stopped before reaching older months)',
    );
    expect(text).toContain('--allow-all-departed --from 2026-03');
  });
});

describe('process log details', () => {
  it('a pg-style error logs its message, code and stack, but posts only the safe text', async () => {
    const h = harness();
    const pgError = Object.assign(
      new Error('relation "report_snapshots" does not exist'),
      { code: '42P01' },
    );
    vi.spyOn(h.snapshots, 'getCurrentMeta').mockRejectedValue(pgError);
    await h.run({ from: { year: 2026, month: 9 } });
    const logged = h.log.error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('relation "report_snapshots" does not exist');
    expect(logged).toContain('42P01');
    expect(logged).toMatch(/\n\s+at /); // the stack
    const posted = JSON.stringify(h.post.mock.calls);
    expect(posted).not.toContain('report_snapshots');
    expect(posted).not.toContain('42P01');
    expect(h.finalText()).toContain(
      'September 2026: Error (details in the process log)',
    );
  });

  it("a ClientError's body reaches neither the log nor a post", async () => {
    const h = harness();
    h.fetchMonthReports.mockRejectedValueOnce(clientError(500));
    await h.run({ from: { year: 2026, month: 9 } });
    const logged = h.log.error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('ClientError: Meetup API error (HTTP 500)');
    expect(logged).not.toContain('SECRET_BODY');
    expect(JSON.stringify(h.post.mock.calls)).not.toContain('SECRET_BODY');
  });
});

describe('one run at a time', () => {
  it('takes the run lock, refreshes it each month and releases it', async () => {
    expect(BACKFILL_RUN_LOCK_KEY).toBe('report-backfill-run');
    // Above one month's lease wait (20 min) plus its build.
    expect(BACKFILL_RUN_LOCK_TTL_SEC).toBe(30 * 60);
    const h = harness();
    const seen: { value?: string; ttl?: number }[] = [];
    h.fetchMonthReports.mockImplementation((period) => {
      seen.push({
        value: h.cache.values.get(BACKFILL_RUN_LOCK_KEY),
        ttl: h.cache.ttls.get(BACKFILL_RUN_LOCK_KEY),
      });
      // Time passes during each build; the refresh must push the expiry on.
      h.clock.set(
        new Date(h.clock.now().getTime() + 20 * 60_000).toISOString(),
      );
      return Promise.resolve(monthReports(period));
    });
    const setSpy = vi.spyOn(h.cache, 'set_existing');
    const result = await h.run({ from: { year: 2026, month: 7 } });
    // 3 builds of 20 minutes each: 60 minutes, past a 30-minute TTL unless refreshed.
    expect(result.built).toHaveLength(3);
    expect(result.stopped).toBeUndefined();
    expect(new Set(seen.map((x) => x.value)).size).toBe(1);
    expect(seen[0].value).toBeDefined();
    expect(seen.every((x) => x.ttl === BACKFILL_RUN_LOCK_TTL_SEC)).toBe(true);
    expect(
      setSpy.mock.calls.filter(([k]) => k === BACKFILL_RUN_LOCK_KEY).length,
    ).toBeGreaterThanOrEqual(3);
    expect(h.cache.values.has(BACKFILL_RUN_LOCK_KEY)).toBe(false);
  });

  it('Redis failing to take the run lock refuses as cache-unavailable', async () => {
    const h = harness();
    vi.spyOn(h.cache, 'exclusive_set').mockRejectedValue(new Error('timeout'));
    await expect(h.run()).rejects.toEqual(
      new BackfillRefusedError('cache-unavailable'),
    );
    expect(h.post).not.toHaveBeenCalled();
  });

  it('refuses a second concurrent run and posts nothing', async () => {
    const h = harness();
    await h.cache.set(
      BACKFILL_RUN_LOCK_KEY,
      'other-run',
      BACKFILL_RUN_LOCK_TTL_SEC,
    );
    await expect(h.run()).rejects.toEqual(
      new BackfillRefusedError('already-running'),
    );
    expect(h.post).not.toHaveBeenCalled();
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(h.cache.values.get(BACKFILL_RUN_LOCK_KEY)).toBe('other-run');
  });

  it('a refused start (identity sweep) releases the run lock it took', async () => {
    const h = harness();
    await h.cache.set(identityDigestClaimKey('2026-10-16'), '1');
    await expect(h.run()).rejects.toEqual(
      new BackfillRefusedError('identity-sweep'),
    );
    expect(h.cache.values.has(BACKFILL_RUN_LOCK_KEY)).toBe(false);
  });

  it('releases the run lock on SIGTERM', async () => {
    const h = harness();
    h.fetchMonthReports.mockImplementation((period) => {
      h.stop.requested = true;
      return Promise.resolve(monthReports(period));
    });
    const result = await h.run();
    expect(result.stopped).toBe('stopped');
    expect(h.cache.values.has(BACKFILL_RUN_LOCK_KEY)).toBe(false);
  });

  it('a lost or unrefreshable run lock stops the run as cache-unavailable', async () => {
    const h = harness();
    h.fetchMonthReports.mockImplementationOnce(async (period) => {
      await h.cache.set(BACKFILL_RUN_LOCK_KEY, 'someone-else', 60);
      return monthReports(period);
    });
    const result = await h.run();
    expect(result.built.map(key)).toEqual(['2026-09']);
    expect(result.stopped).toBe('cache-unavailable');
    // Not ours any more: left alone.
    expect(h.cache.values.get(BACKFILL_RUN_LOCK_KEY)).toBe('someone-else');

    const failing = harness();
    failing.fetchMonthReports.mockImplementationOnce((period) => {
      vi.spyOn(failing.cache, 'set_existing').mockRejectedValue(
        new Error('timeout'),
      );
      return Promise.resolve(monthReports(period));
    });
    expect((await failing.run()).stopped).toBe('cache-unavailable');
    expect(failing.titles()[failing.titles().length - 1]).toBe(
      'Report backfill stopped',
    );
  });
});

describe('re-check after the lease wait', () => {
  it('a month built by the job while the backfill waited is skipped, not rebuilt', async () => {
    const h = harness();
    const SEPT = { year: 2026, month: 9 };
    await h.cache.set(BUILD_LEASE_KEY, 'job-lease', 2 * 60);
    // The job finishes September while the backfill waits for its lease.
    h.sleep.mockImplementationOnce((ms) => {
      h.snapshots.seedBoth(SEPT, '2026-10-16T19:31:00Z');
      h.clock.set(new Date(h.clock.now().getTime() + ms).toISOString());
      return Promise.resolve();
    });
    const result = await h.run({ from: SEPT });
    expect(h.fetchMonthReports).not.toHaveBeenCalled();
    expect(result.skipped.map(key)).toEqual(['2026-09']);
    expect(result.built).toEqual([]);
    expect(h.cache.values.has(BUILD_LEASE_KEY)).toBe(false);
  });

  it('--force still rebuilds it', async () => {
    const h = harness();
    const SEPT = { year: 2026, month: 9 };
    h.snapshots.seedBoth(SEPT, '2026-10-16T19:31:00Z');
    const result = await h.run({ from: SEPT, force: true });
    expect(result.built.map(key)).toEqual(['2026-09']);
  });
});

describe('lease release failure', () => {
  it('a release that times out stops the run as cache-unavailable and still posts the summary', async () => {
    // Only the lease release's read times out.
    const h = harness(undefined, (inner) => ({
      get: (k: string) => {
        if (k === BUILD_LEASE_KEY) {
          return Promise.reject(new Error('cache get timed out after 5000 ms'));
        }
        return inner.get(k);
      },
      set: (k: string, v: string, t?: number) => inner.set(k, v, t),
      exclusive_set: (k: string, v: string, t?: number) =>
        inner.exclusive_set(k, v, t),
      set_existing: (k: string, v: string, t?: number) =>
        inner.set_existing(k, v, t),
      remove: (k: string) => inner.remove(k),
    }));
    const result = await h.run();
    expect(result.built.map(key)).toEqual(['2026-09']);
    expect(result.stopped).toBe('cache-unavailable');
    expect(h.titles()[h.titles().length - 1]).toBe('Report backfill stopped');
    expect(
      h.finalText().startsWith(BACKFILL_STOP_TEXT['cache-unavailable']),
    ).toBe(true);
  });
});

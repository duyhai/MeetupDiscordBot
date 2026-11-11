import { ClientError } from 'graphql-request';
import { describe, expect, it, vi } from 'vitest';

import { LogEntry } from '../../../src/lib/helpers/discordLogger.js';
import { EventSummary } from '../../../src/lib/client/meetup/types.js';
import { BUILD_LEASE_KEY } from '../../../src/lib/reports/buildLease.js';
import { InMemoryMemberRepository } from '../../../src/lib/repositories/inMemoryMemberRepository.js';
import {
  BackfillDeps,
  FRESH_CURRENT_YEAR_MS,
  TickOutcome,
  OrganizerReads,
  QUEUE_MAX_ATTEMPTS,
  RUN_INTERVAL_MS,
  RUN_NOW_KEY,
  TICK_CALL_BUDGET,
  isFresh,
  runBackfillTick,
  startWrappedBackfillScheduler,
  yearsFor,
} from '../../../src/lib/wrapped/backfill.js';
import { WrappedMeetup } from '../../../src/lib/wrapped/build.js';
import {
  CachedWrapped,
  buildingKey,
  readWrapped,
  wrappedCacheKey,
  writeWrapped,
} from '../../../src/lib/wrapped/cache.js';
import {
  BACKFILL_TICK_MS,
  MEMBERS_PER_TICK,
  NEXT_TICK_KEY,
} from '../../../src/lib/wrapped/queue.js';
import { FakeCache } from '../../web/fakeCache.js';
import { FakeBackfillStore } from './backfillFakes.js';

/** 2026-12-10, 12:00 Pacific (20:00 UTC: outside the quiet hour). */
const NOW = new Date('2026-12-10T20:00:00Z');
const GROUP = '7595882';

const ev = (id: string, iso: string, title = `Event ${id}`): EventSummary => ({
  id,
  title,
  dateTime: iso,
  eventUrl: `https://www.meetup.com/e/${id}/`,
});

const page = <T>(nodes: T[]) => ({
  pageInfo: {
    hasNextPage: false,
    hasPreviousPage: false,
    startCursor: null as string | null,
    endCursor: null as string | null,
  },
  totalCount: nodes.length,
  edges: nodes.map((node) => ({ node })),
});

interface FakeMember {
  discordUserId: string;
  meetupId: string;
  /** The member's own token, when one is stored. */
  token?: string;
  events: EventSummary[];
}

const members: FakeMember[] = [
  {
    discordUserId: '100000000000000001',
    meetupId: 'm1',
    token: 't1',
    events: [
      ev('a1', '2024-03-02T10:00:00-08:00', 'Hike'),
      ev('a2', '2026-05-10T19:00:00-07:00', 'Trivia'),
    ],
  },
  {
    discordUserId: '100000000000000002',
    meetupId: 'm2',
    events: [ev('b1', '2025-07-04T10:00:00-07:00', 'Picnic')],
  },
  {
    discordUserId: '100000000000000003',
    meetupId: 'm3',
    token: 't3',
    events: [ev('c1', '2013-01-04T10:00:00-08:00', 'Ancient')],
  },
];

function meetupFor(
  member: FakeMember | undefined,
  calls: { n: number },
  options: { selfError?: Error } = {},
): WrappedMeetup {
  return {
    getSelfPastRsvpEvents: vi.fn(async () => {
      calls.n += 1;
      if (options.selfError) {
        throw options.selfError;
      }
      return { events: member?.events ?? [], meetupId: member?.meetupId ?? '' };
    }),
    getHostedEvents: vi.fn(async () => {
      calls.n += 1;
      return { groupByUrlname: { id: GROUP, events: page([]) } };
    }),
    getEventRsvps: vi.fn(async (eventId: string) => {
      calls.n += 1;
      return { event: { id: eventId, rsvps: page([]) } };
    }),
  };
}

interface Harness {
  deps: BackfillDeps;
  store: FakeBackfillStore;
  cache: FakeCache;
  repo: InMemoryMemberRepository;
  alert: ReturnType<typeof vi.fn>;
  clock: { now: number };
  calls: { n: number };
  organizerCalls: { n: number };
  organizerUsedFor: string[];
  canStart: ReturnType<typeof vi.fn>;
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

async function harness({
  linked = members,
  quiet = false,
  memberFailure,
  organizerFailure,
}: {
  linked?: FakeMember[];
  quiet?: boolean;
  /** Thrown by the member-token history read of this Discord id. */
  memberFailure?: { discordUserId: string; error: Error };
  organizerFailure?: { meetupId: string; error: Error };
} = {}): Promise<Harness> {
  const clock = { now: NOW.getTime() };
  const store = new FakeBackfillStore(() => clock.now);
  const cache = new FakeCache();
  const repo = new InMemoryMemberRepository();
  for (const m of linked) {
    // eslint-disable-next-line no-await-in-loop -- test setup
    await repo.upsert({
      discordUserId: m.discordUserId,
      meetupId: m.meetupId,
      meetupName: null,
      meetupMemberUrl: null,
      onboardMethod: 'self_onboard',
      onboardedBy: null,
    });
  }
  const calls = { n: 0 };
  const organizerCalls = { n: 0 };
  const organizerUsedFor: string[] = [];
  const alert = vi.fn(async (_entry: LogEntry) => true);
  const canStart = vi.fn(async () => !quiet);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: BackfillDeps = {
    now: () => new Date(clock.now),
    cache: async () => cache,
    store: async () => store,
    members: async () => repo,
    memberToken: async (discordUserId) =>
      linked.find((m) => m.discordUserId === discordUserId)?.token,
    memberClient: (token) => {
      const member = linked.find((m) => m.token === token);
      return meetupFor(member, calls, {
        selfError:
          memberFailure?.discordUserId === member?.discordUserId
            ? memberFailure.error
            : undefined,
      });
    },
    withOrganizer: async (fn) => {
      const organizer: OrganizerReads = {
        ...meetupFor(undefined, organizerCalls),
        getMemberRsvpEvents: vi.fn(async (meetupId: string) => {
          organizerCalls.n += 1;
          organizerUsedFor.push(meetupId);
          if (organizerFailure?.meetupId === meetupId) {
            throw organizerFailure.error;
          }
          return linked.find((m) => m.meetupId === meetupId)?.events;
        }),
      };
      return fn(organizer);
    },
    isPresent: async () => true,
    canStart,
    alert,
    newLeaseValue: () => 'lease-1',
    groupId: GROUP,
    log,
  };
  return {
    deps,
    store,
    cache,
    repo,
    alert,
    clock,
    calls,
    organizerCalls,
    organizerUsedFor,
    canStart,
    log,
  };
}

/** A run that just finished: the sweep is not due, so a tick only drains the queue. */
async function recentRun(h: Harness): Promise<void> {
  const run = await h.store.startRun('job', 0);
  await h.store.finishRun(run.id);
}

const meetupError = (status: number) =>
  new ClientError(
    { status, headers: new Headers(), body: '', errors: [] },
    { query: 'q' },
  );

async function cachedYears(h: Harness, member: FakeMember): Promise<number[]> {
  const years = await Promise.all(
    [2024, 2025, 2026].map(async (year) => {
      const copy = await readWrapped(
        h.cache,
        member.discordUserId,
        year,
        member.meetupId,
      );
      return copy ? year : undefined;
    }),
  );
  return years.filter((year): year is number => year !== undefined);
}

describe('yearsFor', () => {
  it('runs from the first event’s Pacific year to this year, never before 2015', () => {
    expect(yearsFor(members[0].events, NOW)).toEqual([2024, 2025, 2026]);
    expect(yearsFor(members[2].events, NOW)).toEqual([
      2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026,
    ]);
    expect(yearsFor([], NOW)).toEqual([2026]);
  });
});

describe('isFresh', () => {
  const copy = (year: number, builtAt: Date): CachedWrapped => ({
    meetupId: 'm1',
    stats: {
      year,
      firstEvent: null,
      attendedThisYear: 0,
      attendedAllTime: 0,
      topTypes: [],
      hosting: null,
      busiestMonth: null,
      longestStreakMonths: 0,
      activeYears: [],
    },
    companions: { named: [], otherCount: 0 },
    builtAt: builtAt.toISOString(),
  });

  it('a past year is fresh whenever it is cached for the current Meetup id', () => {
    expect(
      isFresh(copy(2025, new Date('2025-01-01T00:00:00Z')), 'm1', 2025, NOW),
    ).toBe(true);
    expect(isFresh(copy(2025, NOW), 'other', 2025, NOW)).toBe(false);
    expect(isFresh(undefined, 'm1', 2025, NOW)).toBe(false);
  });

  it('the current year is fresh for seven days', () => {
    expect(FRESH_CURRENT_YEAR_MS).toBe(7 * 24 * 60 * 60_000);
    const sixDays = new Date(NOW.getTime() - 6 * 24 * 60 * 60_000);
    const eightDays = new Date(NOW.getTime() - 8 * 24 * 60 * 60_000);
    expect(isFresh(copy(2026, sixDays), 'm1', 2026, NOW)).toBe(true);
    expect(isFresh(copy(2026, eightDays), 'm1', 2026, NOW)).toBe(false);
  });
});

describe('runBackfillTick', () => {
  it('does nothing in the quiet hour or while the digest runs', async () => {
    const h = await harness({ quiet: true });
    await h.store.enqueue({
      discordUserId: members[0].discordUserId,
      meetupId: 'm1',
      year: 2026,
    });

    expect(await runBackfillTick(h.deps)).toEqual({
      kind: 'skipped',
      reason: 'guard',
    });
    expect(h.calls.n).toBe(0);
    expect(await h.store.queueLength()).toBe(1);
    expect(await h.store.openRun()).toBeUndefined();
  });

  it('drains the queue before the sweep, oldest first, and writes the cache entry readWrapped serves', async () => {
    const h = await harness();
    await h.store.enqueue({
      discordUserId: members[1].discordUserId,
      meetupId: 'm2',
      year: 2025,
    });
    h.clock.now += 1000;
    await h.store.enqueue({
      discordUserId: members[0].discordUserId,
      meetupId: 'm1',
      year: 2026,
    });
    // A recent run: the sweep is not due, so only the queue runs.
    const run = await h.store.startRun('job', 3);
    await h.store.finishRun(run.id);

    const outcome = await runBackfillTick(h.deps);

    expect(outcome).toMatchObject({
      kind: 'ran',
      queued: 2,
      built: 2,
      members: 0,
    });
    expect(await h.store.queueLength()).toBe(0);
    const b = await readWrapped(h.cache, members[1].discordUserId, 2025, 'm2');
    expect(b?.stats).toMatchObject({ year: 2025, attendedThisYear: 1 });
    const a = await readWrapped(h.cache, members[0].discordUserId, 2026, 'm1');
    expect(a?.stats.attendedThisYear).toBe(1);
    // The one with a token used it; the other went through the organizer.
    expect(h.organizerUsedFor).toEqual(['m2']);
    expect(
      h.cache.values.has(buildingKey(members[0].discordUserId, 2026)),
    ).toBe(false);
  });

  it('drops a queued row whose copy appeared meanwhile, unbuilt', async () => {
    const h = await harness();
    const m = members[0];
    await recentRun(h);
    await h.store.enqueue({
      discordUserId: m.discordUserId,
      meetupId: 'm1',
      year: 2026,
    });
    const copy = await (async () => {
      const g = await harness();
      await g.store.enqueue({
        discordUserId: m.discordUserId,
        meetupId: 'm1',
        year: 2026,
      });
      await runBackfillTick(g.deps);
      return readWrapped(g.cache, m.discordUserId, 2026, 'm1');
    })();
    await writeWrapped(h.cache, m.discordUserId, 2026, copy, NOW);

    const outcome = await runBackfillTick(h.deps);

    expect(outcome).toMatchObject({ queued: 1, built: 0, skipped: 1 });
    expect(h.calls.n).toBe(0);
    expect(await h.store.queueLength()).toBe(0);
  });

  it('drops a queued member who is no longer linked', async () => {
    const h = await harness({ linked: [members[0]] });
    await recentRun(h);
    await h.store.enqueue({
      discordUserId: '100000000000000009',
      meetupId: 'gone',
      year: 2026,
    });

    const outcome = await runBackfillTick(h.deps);

    expect(outcome).toMatchObject({ queued: 1, built: 0 });
    expect(await h.store.queueLength()).toBe(0);
    expect(h.calls.n + h.organizerCalls.n).toBe(0);
    const logged = JSON.stringify([
      ...h.log.info.mock.calls,
      ...h.log.warn.mock.calls,
    ]);
    expect(logged).not.toContain('gone');
  });

  it('releases a failed queued build and drops it after three attempts', async () => {
    const m = members[0];
    const h = await harness({
      memberFailure: {
        discordUserId: m.discordUserId,
        error: new Error('rsvps down'),
      },
    });
    await recentRun(h);
    await h.store.enqueue({
      discordUserId: m.discordUserId,
      meetupId: 'm1',
      year: 2026,
    });
    expect(QUEUE_MAX_ATTEMPTS).toBe(3);

    expect(await runBackfillTick(h.deps)).toMatchObject({
      queued: 1,
      failed: 1,
    });
    expect((await h.store.position(m.discordUserId))?.row.attempts).toBe(1);
    await runBackfillTick(h.deps);
    await runBackfillTick(h.deps);
    expect(await h.store.queueLength()).toBe(0);
    expect(JSON.stringify(h.log.warn.mock.calls)).toContain('Error');
    expect(JSON.stringify(h.log.warn.mock.calls)).not.toContain('rsvps down');
  });

  it('starts a run when none finished in 20 hours, sweeps members in Discord-id order, at most four a tick', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      discordUserId: `10000000000000001${i}`,
      meetupId: `mm${i}`,
      token: `tt${i}`,
      events: [ev(`e${i}`, '2026-02-01T19:00:00-08:00')],
    }));
    const h = await harness({ linked: many });
    expect(RUN_INTERVAL_MS).toBe(20 * 60 * 60_000);

    const first = await runBackfillTick(h.deps);

    expect(first).toMatchObject({
      kind: 'ran',
      members: MEMBERS_PER_TICK,
      built: 4,
      finishedRun: false,
    });
    const run = await h.store.openRun();
    expect(run).toMatchObject({
      trigger: 'job',
      membersTotal: 6,
      membersDone: 4,
      cursor: many[3].discordUserId,
    });

    const second = await runBackfillTick(h.deps);
    expect(second).toMatchObject({ members: 2, built: 2, finishedRun: true });
    expect(await h.store.openRun()).toBeUndefined();
    expect((await h.store.lastFinishedRun())?.membersDone).toBe(6);

    // Not due again for 20 hours.
    expect(await runBackfillTick(h.deps)).toEqual({
      kind: 'skipped',
      reason: 'no-work',
    });
    h.clock.now += RUN_INTERVAL_MS + 1;
    expect(await runBackfillTick(h.deps)).toMatchObject({
      kind: 'ran',
      members: 4,
    });
  });

  it('builds every year from the first event (never before 2015) and skips fresh copies', async () => {
    const h = await harness({ linked: [members[0], members[2]] });

    await runBackfillTick(h.deps);

    expect(await cachedYears(h, members[0])).toEqual([2024, 2025, 2026]);
    const ancient = members[2];
    expect(
      await readWrapped(h.cache, ancient.discordUserId, 2015, 'm3'),
    ).toBeDefined();
    expect(
      h.cache.values.has(wrappedCacheKey(ancient.discordUserId, 2014)),
    ).toBe(false);
    expect(await h.store.lastFinishedRun()).toMatchObject({
      built: 15,
      skipped: 0,
    });

    // A second run: every year is fresh (past years always, this year for a week).
    h.clock.now += RUN_INTERVAL_MS + 1;
    const again = await runBackfillTick(h.deps);
    expect(again).toMatchObject({ built: 0, skipped: 15 });
  });

  it('rebuilds a current-year copy older than seven days and leaves a younger one', async () => {
    const h = await harness({ linked: [members[0]] });
    await runBackfillTick(h.deps);
    h.clock.now += 8 * 24 * 60 * 60_000;

    const outcome = await runBackfillTick(h.deps);

    expect(outcome).toMatchObject({ built: 1, skipped: 2 });
    const copy = await readWrapped(
      h.cache,
      members[0].discordUserId,
      2026,
      'm1',
    );
    expect(copy?.builtAt).toBe(new Date(h.clock.now).toISOString());
  });

  it('stops starting builds once the call budget is spent, and resumes from the cursor next tick', async () => {
    const busy = Array.from({ length: 3 }, (_, i) => ({
      discordUserId: `10000000000000002${i}`,
      meetupId: `mb${i}`,
      token: `tb${i}`,
      // Many events this year: each costs an attendee read.
      events: Array.from({ length: 80 }, (_, j) =>
        ev(
          `b${i}-${j}`,
          `2026-0${1 + (j % 9)}-${String(1 + (j % 28)).padStart(2, '0')}T19:00:00-08:00`,
        ),
      ),
    }));
    const h = await harness({ linked: busy });
    expect(TICK_CALL_BUDGET).toBe(150);

    const first = await runBackfillTick(h.deps);

    expect(first).toMatchObject({ kind: 'ran', finishedRun: false });
    expect(first.kind === 'ran' ? first.members : 0).toBeLessThan(3);
    expect(first.kind === 'ran' ? first.calls : 0).toBeGreaterThanOrEqual(
      TICK_CALL_BUDGET,
    );
    const cursor = (await h.store.openRun())?.cursor;
    expect(cursor).toBeDefined();

    const second = await runBackfillTick(h.deps);
    expect(second).toMatchObject({ kind: 'ran' });
    expect(
      (await h.store.openRun())?.cursor ??
        (await h.store.lastFinishedRun())?.cursor,
    ).not.toBe(cursor);
  });

  it('a member whose build fails is counted and retried next run (cursor moves past them)', async () => {
    const h = await harness({
      memberFailure: {
        discordUserId: members[0].discordUserId,
        error: new Error('boom'),
      },
    });

    const outcome = await runBackfillTick(h.deps);

    expect(outcome).toMatchObject({ members: 3, failed: 1, finishedRun: true });
    expect(await h.store.lastFinishedRun()).toMatchObject({
      failed: 1,
      cursor: members[2].discordUserId,
    });
    expect(await cachedYears(h, members[0])).toEqual([]);
    expect(await cachedYears(h, members[1])).toEqual([2025, 2026]);
  });

  it('stops at the quiet hour and leaves the cursor behind', async () => {
    const h = await harness();
    // Allowed at the tick's start and for the first member; then the hour starts.
    h.canStart
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    const outcome = await runBackfillTick(h.deps);

    expect(outcome).toMatchObject({
      kind: 'ran',
      members: 1,
      finishedRun: false,
    });
    expect((await h.store.openRun())?.cursor).toBe(members[0].discordUserId);
    expect(h.cache.values.has(BUILD_LEASE_KEY)).toBe(false);
    for (const year of [2024, 2025, 2026]) {
      expect(
        h.cache.values.has(buildingKey(members[1].discordUserId, year)),
      ).toBe(false);
    }
  });

  it('uses the member token when stored and the organizer reads otherwise, under the report lease', async () => {
    const h = await harness({ linked: [members[0], members[1]] });
    const leaseSeen: boolean[] = [];
    const base = { ...h.deps };
    h.deps.withOrganizer = async (fn) => {
      leaseSeen.push(h.cache.values.get(BUILD_LEASE_KEY) === 'lease-1');
      return base.withOrganizer(fn);
    };

    await runBackfillTick(h.deps);

    expect(h.organizerUsedFor).toEqual(['m2']);
    expect(leaseSeen).toEqual([true]);
    expect(h.cache.values.has(BUILD_LEASE_KEY)).toBe(false);
  });

  it('ends the tick when the report lease is held (the report job is reading Meetup)', async () => {
    const h = await harness({ linked: [members[1], members[0]] });
    await h.cache.set(BUILD_LEASE_KEY, 'someone-else');

    const outcome = await runBackfillTick(h.deps);

    expect(outcome).toMatchObject({ kind: 'ran', members: 1 });
    // The member-token build (members[0], lower id) went ahead; the organizer one waits.
    expect(await cachedYears(h, members[0])).toEqual([2024, 2025, 2026]);
    expect(await cachedYears(h, members[1])).toEqual([]);
    expect((await h.store.openRun())?.cursor).toBe(members[0].discordUserId);
  });

  it('falls back to the organizer path on an account mismatch or a 401', async () => {
    const mismatch: FakeMember = { ...members[0], events: [], token: 'tx' };
    const h = await harness({
      linked: [mismatch, members[2]],
      memberFailure: {
        discordUserId: members[2].discordUserId,
        error: meetupError(401),
      },
    });
    // The stored token for the first member belongs to another Meetup account.
    h.deps.memberClient = (token) => {
      return token === 'tx'
        ? { ...meetupFor({ ...mismatch, meetupId: 'someone-else' }, h.calls) }
        : meetupFor(members[2], h.calls, { selfError: meetupError(401) });
    };

    await runBackfillTick(h.deps);

    expect(h.organizerUsedFor).toEqual(['m1', 'm3']);
    expect(
      await readWrapped(h.cache, mismatch.discordUserId, 2026, 'm1'),
    ).toBeDefined();
    expect(
      h.cache.values.has(wrappedCacheKey(mismatch.discordUserId, 2026)),
    ).toBe(true);
  });

  it('a member the organizer cannot see is skipped, not failed', async () => {
    const h = await harness({ linked: [members[1]] });
    h.deps.withOrganizer = async (fn) =>
      fn({
        ...meetupFor(undefined, h.organizerCalls),
        getMemberRsvpEvents: vi.fn(async () => undefined),
      });

    const outcome = await runBackfillTick(h.deps);

    expect(outcome).toMatchObject({ members: 1, failed: 0, skipped: 1 });
  });

  it('never spends the hourly slot and releases the building lease', async () => {
    const h = await harness({ linked: [members[0]] });
    await h.cache.exclusive_set(
      buildingKey(members[0].discordUserId, 2025),
      'on-demand',
      60,
    );

    const outcome = await runBackfillTick(h.deps);

    // 2025 was being built elsewhere: skipped; the other two built.
    expect(outcome).toMatchObject({ built: 2, skipped: 1 });
    expect(
      h.cache.values.get(buildingKey(members[0].discordUserId, 2025)),
    ).toBe('on-demand');
    expect(
      h.cache.values.has(buildingKey(members[0].discordUserId, 2026)),
    ).toBe(false);
  });

  it('honours Run now: starts a run at once and clears the flag', async () => {
    const h = await harness({ linked: [members[0]] });
    const run = await h.store.startRun('job', 1);
    await h.store.finishRun(run.id);
    await h.cache.set(RUN_NOW_KEY, '200000000000000001', 3600);
    h.clock.now += 1000;

    const outcome = await runBackfillTick(h.deps);

    expect(outcome).toMatchObject({
      kind: 'ran',
      members: 1,
      finishedRun: true,
    });
    expect((await h.store.lastFinishedRun())?.trigger).toBe(
      '200000000000000001',
    );
    expect(h.cache.values.has(RUN_NOW_KEY)).toBe(false);
  });

  it('finishes the run with one plain summary alert', async () => {
    const h = await harness();

    await runBackfillTick(h.deps);

    expect(h.alert).toHaveBeenCalledTimes(1);
    const entry = h.alert.mock.calls[0][0] as LogEntry;
    expect(entry.title).toBe('Wrapped backfill finished');
    expect(entry.description).toContain('3 members');
    expect(entry.description).toContain('built 17');
    expect(entry.description).not.toMatch(/<@/);
  });
});

describe('startWrappedBackfillScheduler', () => {
  it('ticks now and every 5 minutes, records the next tick, and skips while a tick runs', async () => {
    let resolveTick: (() => void) | undefined;
    const cache = new FakeCache();
    const tick = vi.fn(
      () =>
        new Promise<TickOutcome>((resolve) => {
          resolveTick = () => resolve({ kind: 'skipped', reason: 'no-work' });
        }),
    );
    const intervals: { fn: () => void; ms: number }[] = [];
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    startWrappedBackfillScheduler(
      {} as never,
      async () => ({ cache: async () => cache, now: () => NOW }) as never,
      {
        env: { DATABASE_URL: 'postgres://x' },
        setIntervalFn: (fn: () => void, ms: number) => {
          intervals.push({ fn, ms });
          return 0 as never;
        },
        log,
        now: () => NOW.getTime(),
        runTick: tick,
      },
    );
    expect(intervals[0].ms).toBe(BACKFILL_TICK_MS);
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    expect(tick).toHaveBeenCalledTimes(1);
    expect(cache.values.get(NEXT_TICK_KEY)).toBe(
      new Date(NOW.getTime() + BACKFILL_TICK_MS).toISOString(),
    );
    intervals[0].fn(); // still running: skipped
    expect(tick).toHaveBeenCalledTimes(1);
    resolveTick?.();
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    intervals[0].fn();
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('is off without DATABASE_URL', () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const setIntervalFn = vi.fn();
    startWrappedBackfillScheduler({} as never, async () => ({}) as never, {
      env: {},
      setIntervalFn: setIntervalFn as never,
      log,
    });
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('DATABASE_URL'),
    );
  });
});

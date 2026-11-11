import { ClientError } from 'graphql-request';
import { describe, expect, it, vi } from 'vitest';

import { LogEntry } from '../../../src/lib/helpers/discordLogger.js';
import { EventSummary } from '../../../src/lib/client/meetup/types.js';
import { BUILD_LEASE_KEY } from '../../../src/lib/reports/buildLease.js';
import { OrganizerTokenUnavailableError } from '../../../src/lib/reports/organizerMeetup.js';
import { InMemoryMemberRepository } from '../../../src/lib/repositories/inMemoryMemberRepository.js';
import {
  BackfillDeps,
  FRESH_CURRENT_YEAR_MS,
  MEMBER_LEASE_KEY_PREFIX,
  TickOutcome,
  memoSize,
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
} from '../../../src/lib/wrapped/cache.js';
import {
  BACKFILL_TICK_MS,
  MEMBERS_PER_TICK,
  NEXT_TICK_KEY,
} from '../../../src/lib/wrapped/queue.js';
import { FakeCache } from '../../web/fakeCache.js';
import { FakeBackfillStore, FakeEntryStore } from './backfillFakes.js';

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

/** Attendee ids per event id, for the memo and first-page tests; `big` events report a second page. */
const attendeesOf: Record<string, string[]> = {};
const bigEvents = new Set<string>();
/** Every attendee read any client made this test: event id and page cursor. */
let rsvpReads: { eventId: string; after: string | undefined }[] = [];

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
    getEventRsvps: vi.fn(async (eventId: string, input: { after?: string }) => {
      calls.n += 1;
      rsvpReads.push({ eventId, after: input.after });
      if (input.after !== undefined && input.after !== 'cursor-2') {
        throw new Error(`unknown cursor ${input.after}`);
      }
      const ids = attendeesOf[eventId] ?? [];
      const nodes = ids.map((id) => ({
        status: 'YES' as const,
        member: {
          id,
          name: `Member ${id}`,
          memberUrl: '',
          gender: 'NONE' as never,
        },
      }));
      const more = bigEvents.has(eventId) && !input.after;
      return {
        event: {
          id: eventId,
          rsvps: {
            ...page(input.after ? [] : nodes),
            pageInfo: {
              hasNextPage: more,
              hasPreviousPage: false,
              startCursor: null,
              endCursor: more ? 'cursor-2' : null,
            },
            totalCount: more ? 150 : ids.length,
          },
        },
      };
    }),
  };
}

interface Harness {
  deps: BackfillDeps;
  store: FakeBackfillStore;
  entries: FakeEntryStore;
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
  rsvpReads = [];
  const clock = { now: NOW.getTime() };
  const store = new FakeBackfillStore(() => clock.now);
  const entries = new FakeEntryStore();
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
    entries: async () => entries,
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
    entries,
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

/** Years with an entry in Postgres (the durable tier) for the member's current link. */
async function cachedYears(h: Harness, member: FakeMember): Promise<number[]> {
  const years = await Promise.all(
    [2015, 2024, 2025, 2026].map(async (year) => {
      const copy = await h.entries.get(member.discordUserId, year);
      return copy?.meetupId === member.meetupId ? year : undefined;
    }),
  );
  return years.filter((year): year is number => year !== undefined);
}

const pagesReadFor = (eventId: string) =>
  rsvpReads.filter((r) => r.eventId === eventId).map((r) => r.after);

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

  it('a past year is fresh only when it was built after that year ended (Pacific)', () => {
    expect(
      isFresh(copy(2025, new Date('2026-01-01T08:00:00Z')), 'm1', 2025, NOW),
    ).toBe(true);
    // Built on 15 December 2025: the late-December events are missing.
    expect(
      isFresh(copy(2025, new Date('2025-12-15T20:00:00Z')), 'm1', 2025, NOW),
    ).toBe(false);
    // 31 December 2025, 23:30 Pacific is still 2025.
    expect(
      isFresh(copy(2025, new Date('2026-01-01T07:30:00Z')), 'm1', 2025, NOW),
    ).toBe(false);
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
    // A past year lives in Postgres only; the current year has a hot copy too.
    const b = await h.entries.get(members[1].discordUserId, 2025);
    expect(b?.stats).toMatchObject({ year: 2025, attendedThisYear: 1 });
    expect(
      h.cache.values.has(wrappedCacheKey(members[1].discordUserId, 2025)),
    ).toBe(false);
    const a = await readWrapped(h.cache, members[0].discordUserId, 2026, 'm1');
    expect(a?.stats.attendedThisYear).toBe(1);
    expect(await h.entries.get(members[0].discordUserId, 2026)).toEqual(a);
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
    await h.entries.put(m.discordUserId, 2026, copy, NOW);

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
    await h.store.enqueue({
      discordUserId: members[1].discordUserId,
      meetupId: 'm2',
      year: 2026,
    });

    // The failing head row does not block the row behind it.
    expect(await runBackfillTick(h.deps)).toMatchObject({
      queued: 2,
      failed: 1,
      built: 1,
    });
    expect((await h.store.position(m.discordUserId))?.row.attempts).toBe(1);
    expect(await h.store.position(members[1].discordUserId)).toBeUndefined();
    await runBackfillTick(h.deps);
    await runBackfillTick(h.deps);
    expect(await h.store.queueLength()).toBe(0);
    const warned = JSON.stringify(h.log.warn.mock.calls);
    expect(warned).toContain('Error');
    expect(warned).not.toContain('rsvps down');
    // The drop is logged, by Discord id.
    expect(warned).toContain(`dropped after ${QUEUE_MAX_ATTEMPTS} attempts`);
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
    // Due again: every member is fresh, so the run finishes with no call.
    expect(await runBackfillTick(h.deps)).toMatchObject({
      kind: 'ran',
      members: 0,
      calls: 0,
      finishedRun: true,
    });
  });

  it('builds every year from the first event (never before 2015) and skips fresh copies', async () => {
    const h = await harness({ linked: [members[0], members[2]] });

    await runBackfillTick(h.deps);

    expect(await cachedYears(h, members[0])).toEqual([2024, 2025, 2026]);
    const ancient = members[2];
    expect(await h.entries.get(ancient.discordUserId, 2015)).toBeDefined();
    expect(
      h.cache.values.has(wrappedCacheKey(ancient.discordUserId, 2014)),
    ).toBe(false);
    expect(await h.store.lastFinishedRun()).toMatchObject({
      built: 15,
      skipped: 0,
    });

    // A second run: every year is fresh (the past years were built after they
    // ended, this year within the week), so the members are not even read.
    h.clock.now += RUN_INTERVAL_MS + 1;
    const again = await runBackfillTick(h.deps);
    expect(again).toMatchObject({ built: 0, calls: 0, finishedRun: true });
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
    // The tick's start, member A, A's three years; then the hour starts.
    h.canStart
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
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

  it('stops before the next year of a half-built member, with the cursor not advanced', async () => {
    const h = await harness({ linked: [members[0]] });
    // Tick start, member A, year 2024; then the sweep window closes.
    h.canStart
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    const outcome = await runBackfillTick(h.deps);

    expect(outcome).toMatchObject({ kind: 'ran', members: 0, built: 1 });
    expect(await cachedYears(h, members[0])).toEqual([2024]);
    expect((await h.store.openRun())?.cursor).toBeUndefined();
    expect(
      h.cache.values.has(buildingKey(members[0].discordUserId, 2025)),
    ).toBe(false);
  });

  it('skips a member another process is building (a short per-member lease)', async () => {
    const h = await harness({ linked: [members[0], members[1]] });
    await h.cache.exclusive_set(
      `${MEMBER_LEASE_KEY_PREFIX}${members[0].discordUserId}`,
      'other-process',
      600,
    );

    const outcome = await runBackfillTick(h.deps);

    // The other process will advance the cursor past A; this tick stops.
    expect(outcome).toMatchObject({ kind: 'ran', members: 0 });
    expect(h.calls.n).toBe(0);
    expect((await h.store.openRun())?.cursor).toBeUndefined();
  });

  it('reads a shared event’s attendees once per run (an in-process memo of ids), cleared when the run ends', async () => {
    attendeesOf.shared = ['m1', 'm2', 'x'];
    const shared = ev('shared', '2026-03-03T19:00:00-08:00', 'Big Mixer');
    const pair = [
      { ...members[0], events: [shared] },
      { ...members[1], events: [shared] },
    ];
    const h = await harness({ linked: pair });

    const outcome = await runBackfillTick(h.deps);

    expect(outcome).toMatchObject({ finishedRun: true, built: 2 });
    // One attendee read for the shared event across both members.
    expect(pagesReadFor('shared')).toEqual([undefined]);
    // Both saw each other as a companion from the memoized list.
    expect(
      (await h.entries.get(members[1].discordUserId, 2026))?.companions.named,
    ).toMatchObject([
      { discordUserId: members[0].discordUserId, sharedCount: 1 },
    ]);
    expect(memoSize()).toBe(0);
    delete attendeesOf.shared;
  });

  it('reads only the first page of an early event and marks the cohort partial when there was more', async () => {
    attendeesOf.g0 = ['m1', 'old'];
    bigEvents.add('g0');
    const early = Array.from({ length: 3 }, (_, i) =>
      ev(`g${i}`, `${2023 + i}-02-05T19:00:00-08:00`, 'Trivia'),
    );
    const one: FakeMember = {
      ...members[0],
      events: [...early, ev('t26', '2026-02-05T19:00:00-08:00', 'Trivia')],
    };
    attendeesOf.t26 = ['m1', 'old'];
    const h = await harness({ linked: [one] });
    await h.repo.upsert({
      discordUserId: '100000000000000077',
      meetupId: 'old',
      meetupName: null,
      meetupMemberUrl: null,
      onboardMethod: 'self_onboard',
      onboardedBy: null,
    });
    // 2026 alone (a queued year): g0 is read only as an early event. In a
    // sweep it would be 2023's own event, paginated in full, and then the
    // memo's complete list would serve 2026 (not partial).
    await recentRun(h);
    await h.store.enqueue({
      discordUserId: one.discordUserId,
      meetupId: 'm1',
      year: 2026,
    });

    await runBackfillTick(h.deps);

    const copy = await h.entries.get(one.discordUserId, 2026);
    const games = copy?.stats.topTypes.find((t) => t.type === 'games');
    expect(games?.cohort.partial).toBe(true);
    // 'old' was at g0 (first page) and at t26, both among the first events.
    expect(games?.cohort.named).toEqual([
      { discordUserId: '100000000000000077', earlyCount: 2, sharedCount: 1 },
    ]);
    // g0 was read once, first page only (no `after`), even though it had more.
    expect(pagesReadFor('g0')).toEqual([undefined]);
    bigEvents.delete('g0');
    delete attendeesOf.g0;
    delete attendeesOf.t26;
  });

  it('a partial memo entry never feeds a full reader a bogus cursor', async () => {
    // A's first game night X is big (more than one page). A reads X as an
    // early event (first page only). B attended X this year and reads it
    // in full: the memo must not hand B hasNextPage with a made-up cursor.
    attendeesOf.x = ['m1', 'm2', 'p1'];
    bigEvents.add('x');
    const x = ev('x', '2026-02-05T19:00:00-08:00', 'Trivia');
    const a: FakeMember = {
      ...members[0],
      events: [
        ev('ga', '2024-02-05T19:00:00-08:00', 'Trivia'),
        ev('gb', '2025-02-05T19:00:00-08:00', 'Trivia'),
        x,
      ],
    };
    const b: FakeMember = { ...members[1], events: [x] };
    const h = await harness({ linked: [a, b] });
    await recentRun(h);
    // A for 2026 only: X is this year's event for A too, so make X early
    // for A by queueing A's 2024 (X is a first-ten games event, read first
    // page only), then B's 2026 (X in full).
    await h.store.enqueue({
      discordUserId: a.discordUserId,
      meetupId: 'm1',
      year: 2024,
    });
    h.clock.now += 1000;
    await h.store.enqueue({
      discordUserId: b.discordUserId,
      meetupId: 'm2',
      year: 2026,
    });

    const outcome = await runBackfillTick(h.deps);

    expect(outcome).toMatchObject({ queued: 2, built: 2, failed: 0 });
    // Never a cursor Meetup has not issued.
    expect(rsvpReads.map((r) => r.after)).not.toContain('memo');
    expect(pagesReadFor('x')).toEqual([undefined, 'cursor-2']);
    const copy = await h.entries.get(b.discordUserId, 2026);
    expect(copy?.companions.named).toMatchObject([
      { discordUserId: a.discordUserId, sharedCount: 1 },
    ]);
    bigEvents.delete('x');
    delete attendeesOf.x;
  });

  it('an organizer-credential outage ends the tick: no cursor move, no attempt burnt, one alert a day', async () => {
    const h = await harness({ linked: [members[1], members[0]] });
    h.deps.withOrganizer = async () => {
      throw new OrganizerTokenUnavailableError();
    };
    await h.store.enqueue({
      discordUserId: members[1].discordUserId,
      meetupId: 'm2',
      year: 2026,
    });

    const first = await runBackfillTick(h.deps);

    expect(first).toMatchObject({
      kind: 'ran',
      queued: 0,
      members: 0,
      failed: 0,
    });
    expect(
      (await h.store.position(members[1].discordUserId))?.row.attempts,
    ).toBe(0);
    expect(await h.store.openRun()).toBeUndefined();
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect((h.alert.mock.calls[0][0] as LogEntry).title).toBe(
      'Wrapped backfill is failing',
    );
    // The sweep: the token-path member builds; the organizer-path member
    // ends the tick with the cursor before them, and no second alert today.
    await h.store.complete(members[1].discordUserId);
    const second = await runBackfillTick(h.deps);
    expect(second).toMatchObject({ kind: 'ran', members: 1, failed: 0 });
    expect((await h.store.openRun())?.cursor).toBe(members[0].discordUserId);
    expect(h.alert).toHaveBeenCalledTimes(1);
  });

  it('a queue-only tick leaves nothing in the memo', async () => {
    attendeesOf.q = ['m1', 'zed'];
    const h = await harness({
      linked: [
        {
          ...members[0],
          events: [ev('q', '2026-02-05T19:00:00-08:00', 'Trivia')],
        },
      ],
    });
    await recentRun(h);
    await h.store.enqueue({
      discordUserId: members[0].discordUserId,
      meetupId: 'm1',
      year: 2026,
    });

    await runBackfillTick(h.deps);

    expect(memoSize()).toBe(0);
    delete attendeesOf.q;
  });

  it("never lets an unlinked attendee's Meetup name or id into Postgres or the Redis hot copy", async () => {
    attendeesOf.pv = ['m1', 'ghost-77', 'm2'];
    const h = await harness({
      linked: [
        {
          ...members[0],
          events: [ev('pv', '2026-02-05T19:00:00-08:00', 'Trivia')],
        },
        {
          ...members[1],
          events: [ev('pv', '2026-02-05T19:00:00-08:00', 'Trivia')],
        },
      ],
    });

    await runBackfillTick(h.deps);

    const stored = JSON.stringify([...h.entries.rows.values()]);
    const hot = JSON.stringify([...h.cache.values.entries()]);
    for (const text of [stored, hot]) {
      expect(text).not.toContain('ghost-77');
      expect(text).not.toContain('Member ghost-77');
      expect(text).not.toContain('Member m2');
    }
    expect(stored).toContain(members[1].discordUserId);
    delete attendeesOf.pv;
  });

  it('records every call of the tick on the run and stops at a year boundary over budget', async () => {
    const busy: FakeMember = {
      ...members[0],
      // 80 events a year for three years: two years cross the budget.
      events: [2024, 2025, 2026].flatMap((year) =>
        Array.from({ length: 80 }, (_, j) =>
          ev(
            `b${year}-${j}`,
            `${year}-0${1 + (j % 9)}-${String(1 + (j % 28)).padStart(2, '0')}T19:00:00-08:00`,
          ),
        ),
      ),
    };
    const h = await harness({ linked: [busy, members[1]] });
    await h.store.enqueue({
      discordUserId: members[1].discordUserId,
      meetupId: 'm2',
      year: 2026,
    });

    const first = await runBackfillTick(h.deps);

    expect(first).toMatchObject({
      kind: 'ran',
      queued: 1,
      members: 0,
      built: 3,
    });
    expect(JSON.stringify(h.log.info.mock.calls)).toContain('call budget');
    const run = await h.store.openRun();
    expect(run?.cursor).toBeUndefined();
    // Every call this tick is on the run: the drain's and the interrupted member's.
    expect(run?.requests).toBe(first.kind === 'ran' ? first.calls : -1);
    expect(await cachedYears(h, busy)).toEqual([2024, 2025]);

    const second = await runBackfillTick(h.deps);
    expect(second).toMatchObject({ kind: 'ran', finishedRun: true });
    expect(await cachedYears(h, busy)).toEqual([2024, 2025, 2026]);
    expect((await h.store.lastFinishedRun())?.requests).toBe(
      (first.kind === 'ran' ? first.calls : 0) +
        (second.kind === 'ran' ? second.calls : 0),
    );
  });

  it('skips a fully fresh member with no Meetup call and no slot', async () => {
    const h = await harness({ linked: [members[0], members[1]] });
    await runBackfillTick(h.deps);
    const after = h.calls.n + h.organizerCalls.n;
    // The previous year is final (built after it ended) and the current year is fresh.
    h.clock.now += RUN_INTERVAL_MS + 1;

    const again = await runBackfillTick(h.deps);

    expect(again).toMatchObject({
      kind: 'ran',
      finishedRun: true,
      calls: 0,
      members: 0,
    });
    expect(h.calls.n + h.organizerCalls.n).toBe(after);
    expect((await h.store.lastFinishedRun())?.membersDone).toBe(2);
  });

  it('two ticks at once never build one queued row twice', async () => {
    const h = await harness({ linked: [members[0]] });
    await recentRun(h);
    await h.store.enqueue({
      discordUserId: members[0].discordUserId,
      meetupId: 'm1',
      year: 2026,
    });

    const [a, b] = await Promise.all([
      runBackfillTick(h.deps),
      runBackfillTick(h.deps),
    ]);

    const built = [a, b].reduce(
      (n, o) => n + (o.kind === 'ran' ? o.built : 0),
      0,
    );
    expect(built).toBe(1);
    expect(await h.store.queueLength()).toBe(0);
  });

  it('records the run’s Meetup request count', async () => {
    const h = await harness({ linked: [members[0]] });

    const outcome = await runBackfillTick(h.deps);

    expect(outcome.kind === 'ran' ? outcome.calls : -1).toBeGreaterThan(0);
    expect((await h.store.lastFinishedRun())?.requests).toBe(
      outcome.kind === 'ran' ? outcome.calls : -1,
    );
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

  it('alerts once a UTC day when ticks keep failing, by error class only', async () => {
    const cache = new FakeCache();
    const alert = vi.fn(async (_entry: LogEntry) => true);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const intervals: Array<{ fn: () => void }> = [];
    startWrappedBackfillScheduler(
      {} as never,
      async () =>
        ({ cache: async () => cache, now: () => NOW, alert }) as never,
      {
        env: { DATABASE_URL: 'postgres://x' },
        setIntervalFn: ((fn: () => void) => {
          intervals.push({ fn });
          return 0 as never;
        }) as never,
        log,
        now: () => NOW.getTime(),
        runTick: async () => {
          throw new Error('connection refused to secret-host');
        },
      },
    );
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    intervals[0].fn();
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    expect(alert).toHaveBeenCalledTimes(1);
    const entry = alert.mock.calls[0][0];
    expect(entry.title).toBe('Wrapped backfill is failing');
    expect(entry.description).toContain('Error');
    expect(entry.description).not.toContain('secret-host');
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

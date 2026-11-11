import express from 'express';
import { ClientError } from 'graphql-request';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventSummary } from '../../../src/lib/client/meetup/types.js';
import { MemberRecord } from '../../../src/lib/repositories/types.js';
import {
  CachedWrapped,
  buildingKey,
  createBuildLimiter,
  readWrapped,
  wrappedCacheKey,
  writeWrapped,
} from '../../../src/lib/wrapped/cache.js';
import { createHostRouter } from '../../../src/web/host/hostRouter.js';
import {
  WrappedPageDeps,
  registerWrappedPage,
  wrappedYear,
  yearList,
} from '../../../src/web/host/wrappedPage.js';
import { clientFor, listen } from '../../setup/loopbackServer.js';
import {
  DISCORD_USER,
  HOST,
  ORIGIN,
  closeServers,
  makeHostDeps,
  signInWithDiscord,
  signInWithMeetup,
} from './hostHarness.js';
import { FakeCache } from '../fakeCache.js';
import { NEXT_TICK_KEY } from '../../../src/lib/wrapped/queue.js';
import { FakeBackfillStore } from '../../lib/wrapped/backfillFakes.js';

afterEach(closeServers);

const ME = HOST.kind === 'host' ? HOST.meetupMemberId : '';
const USER = DISCORD_USER.id;
// 2026-12-10, 12:00 Pacific.
const NOW = new Date('2026-12-10T20:00:00Z');
const GROUP = '7595882';

function ev(id: string, iso: string, title = `Event ${id}`): EventSummary {
  return {
    id,
    title,
    dateTime: iso,
    eventUrl: `https://www.meetup.com/e/${id}/`,
  };
}

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

const GHOST = { id: 'ghost-7', name: 'Ghost Person' };
const LINKED = { id: 'lk1', name: 'Linked Meetup Name' };
const GONE = { id: 'lk2', name: 'Gone Meetup Name' };

function fakeMeetup({
  meetupId = ME,
  events = [
    ev('1', '2024-03-02T10:00:00-08:00', 'Saturday Hike <b>'),
    ev('2', '2026-05-10T19:00:00-07:00', 'Trivia Night'),
    ev('3', '2026-06-14T19:00:00-07:00', 'Hot Pot Dinner'),
  ],
  delayMs = 0,
  rsvpsError,
}: {
  meetupId?: string;
  events?: EventSummary[];
  delayMs?: number;
  rsvpsError?: Error;
} = {}) {
  const wait = () =>
    new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  return {
    getSelfPastRsvpEvents: vi.fn(async () => {
      await wait();
      return { events, meetupId };
    }),
    getHostedEvents: vi.fn(() =>
      Promise.resolve({ groupByUrlname: { id: GROUP, events: page([]) } }),
    ),
    getEventRsvps: vi.fn((eventId: string) => {
      if (rsvpsError) {
        return Promise.reject(rsvpsError);
      }
      return Promise.resolve({
        event: {
          id: eventId,
          rsvps: page(
            [{ id: ME, name: 'Me' }, GHOST, LINKED, GONE].map(
              ({ id, name }) => ({
                status: 'YES' as const,
                member: { id, name, memberUrl: '', gender: 'NONE' as never },
              }),
            ),
          ),
        },
      });
    }),
  };
}

const record = (discordUserId: string, meetupId: string): MemberRecord => ({
  discordUserId,
  meetupId,
  meetupName: 'x',
  meetupMemberUrl: null,
  onboardMethod: 'self_onboard',
  onboardedBy: null,
  firstOnboardedAt: NOW,
  lastSyncedAt: NOW,
});

const cached: CachedWrapped = {
  meetupId: ME,
  stats: {
    year: 2026,
    firstEvent: {
      id: '1',
      title: 'Saturday Hike <b>',
      dateTime: '2024-03-02T10:00:00-08:00',
      eventUrl: 'https://www.meetup.com/e/1/',
    },
    attendedThisYear: 12,
    attendedAllTime: 40,
    topTypes: [
      {
        type: 'food',
        count: 5,
        firstEvents: [],
        cohort: { named: [], otherCount: 0 },
      },
      {
        type: 'games',
        count: 4,
        firstEvents: [],
        cohort: { named: [], otherCount: 0 },
      },
    ],
    hosting: { thisYear: 1, allTime: 3, topThisYear: [], allTimeBest: null },
    busiestMonth: { month: 6, count: 4, events: [] },
    longestStreakMonths: 5,
    activeYears: [2024, 2025, 2026],
  },
  companions: {
    named: [
      { discordUserId: 'd-linked', sharedCount: 4 },
      { discordUserId: 'd-gone', sharedCount: 2 },
    ],
    otherCount: 5,
  },
  builtAt: '2026-12-01T20:00:00.000Z',
};

const E = (id: string, iso: string, title = `Event ${id}`) => ({
  id,
  title,
  dateTime: iso,
  eventUrl: `https://www.meetup.com/e/${id}/`,
});
const june = [
  E('j1', '2026-06-03T19:00:00-07:00', 'Pho Night'),
  {
    ...E('j2', '2026-06-12T19:00:00-07:00', 'Sneaky'),
    eventUrl: 'javascript:alert(1)',
  },
  E('j3', '2026-06-20T19:00:00-07:00', 'Karaoke'),
];
const firstFood = Array.from({ length: 10 }, (_, i) =>
  E(
    `f${i}`,
    `${2022 + Math.floor(i / 4)}-0${1 + (i % 4)}-05T19:00:00-08:00`,
    `Dinner ${i}`,
  ),
);
/** Ten companions, a seven-strong cohort, six hosted rankings. */
const deep: CachedWrapped = {
  ...cached,
  stats: {
    ...cached.stats,
    topTypes: [
      {
        type: 'food',
        count: 5,
        firstEvents: firstFood,
        cohort: {
          named: Array.from({ length: 7 }, (_, i) => ({
            discordUserId: `30000000000000000${i + 1}`,
            earlyCount: 7 - i,
            sharedCount: 2,
          })),
          otherCount: 3,
        },
      },
      {
        type: 'games',
        count: 4,
        firstEvents: [E('g0', '2025-02-01T19:00:00-08:00', 'Trivia')],
        cohort: { named: [], otherCount: 0 },
      },
    ],
    hosting: {
      thisYear: 6,
      allTime: 9,
      topThisYear: [
        {
          event: E('h1', '2026-04-01T19:00:00-07:00', 'Big Hike'),
          attendance: 31,
        },
        {
          event: E('h2', '2026-05-01T19:00:00-07:00', 'Picnic'),
          attendance: 20,
        },
        { event: E('h3', '2026-06-01T19:00:00-07:00', 'Boba'), attendance: 12 },
        {
          event: E('h4', '2026-07-01T19:00:00-07:00', 'Museum'),
          attendance: 9,
        },
        {
          event: E('h5', '2026-08-01T19:00:00-07:00', 'Bowling'),
          attendance: 4,
        },
      ],
      allTimeBest: {
        event: E('h0', '2023-09-01T19:00:00-07:00', 'Legendary Potluck'),
        attendance: 58,
      },
    },
    busiestMonth: { month: 5, count: 3, events: june },
  },
  companions: {
    named: Array.from({ length: 10 }, (_, i) => ({
      discordUserId: `2000000000000000${String(i + 1).padStart(2, '0')}`,
      sharedCount: 10 - i,
      ...(i === 0 ? { sharedEvents: [june[0], june[2]] } : {}),
    })),
    otherCount: 5,
  },
};

const quiet: CachedWrapped = {
  ...cached,
  stats: {
    ...cached.stats,
    year: 2025,
    attendedThisYear: 0,
    topTypes: [],
    hosting: null,
    busiestMonth: null,
    longestStreakMonths: 0,
  },
  companions: { named: [], otherCount: 0 },
};

interface Harness {
  req: ReturnType<typeof clientFor>;
  cache: FakeCache;
  wrappedCache: FakeCache;
  meetup: ReturnType<typeof fakeMeetup>;
  deps: WrappedPageDeps;
  alert: ReturnType<typeof vi.fn>;
  csrf: () => string;
  store: FakeBackfillStore;
}

async function harness({
  meetup = fakeMeetup(),
  hasToken = true,
  deadlineMs = 2000,
  resolve,
  queue = false,
}: {
  meetup?: ReturnType<typeof fakeMeetup>;
  hasToken?: boolean;
  deadlineMs?: number;
  resolve?: unknown;
  queue?: boolean;
} = {}): Promise<Harness> {
  const clock = { now: NOW.getTime() };
  const wrappedCache = new FakeCache();
  const store = new FakeBackfillStore(() => clock.now);
  const alert = vi.fn().mockResolvedValue(true);
  const deps: WrappedPageDeps = {
    cache: async () => wrappedCache,
    memberToken: vi.fn(async () => {
      return hasToken ? 'member-token' : undefined;
    }),
    meetupClient: vi.fn(() => meetup),
    organizerRsvps: vi.fn(async () => undefined),
    findByMeetupId: async (meetupId) => {
      if (meetupId === LINKED.id) {
        return record('d-linked', LINKED.id);
      }
      return meetupId === GONE.id ? record('d-gone', GONE.id) : undefined;
    },
    isPresent: async () => true,
    displayName: async (discordUserId) => {
      if (discordUserId === 'd-linked') {
        return 'Linked <Pal>';
      }
      // Companions 1–9 and every cohort member resolve; companion 10 does not.
      if (
        /^20000000000000000[1-9]$/.test(discordUserId) ||
        /^30000000000000000\d$/.test(discordUserId)
      ) {
        return `Pal ${discordUserId.slice(-2)}`;
      }
      return undefined;
    },
    limiter: createBuildLimiter(() => clock.now),
    alert,
    groupId: GROUP,
    now: () => new Date(clock.now),
    deadlineMs,
    ...(queue ? { queue: async () => store } : {}),
  };
  const { deps: hostDeps, cache } = makeHostDeps({
    ...(resolve ? { resolve: vi.fn().mockResolvedValue(resolve) } : {}),
    pages: (router) => registerWrappedPage(router, deps),
  });
  const app = express();
  app.set('trust proxy', 1);
  app.use('/host', createHostRouter(hostDeps));
  const req = clientFor(await listen(app));
  const csrf = () => {
    for (const [key, raw] of cache.values) {
      if (key.startsWith('host-session-')) {
        return (JSON.parse(raw) as { csrfToken: string }).csrfToken;
      }
    }
    throw new Error('no session');
  };
  return { req, cache, wrappedCache, meetup, deps, alert, csrf, store };
}

const strip = (text: string) => text.replace(/\s+/g, ' ');

describe('wrappedYear', () => {
  it.each([
    ['2026', 2026],
    ['2015', 2015],
    ['2020', 2020],
    ['1999', 2026],
    ['2027', 2026],
    ['abc', 2026],
    [undefined, 2026],
    [['2020'], 2026],
  ])('%s → %s', (query, year) => {
    expect(wrappedYear(query, NOW)).toBe(year);
  });
});

describe('yearList', () => {
  it('is this year, then every earlier active year, newest first, from any copy', () => {
    const w2024 = {
      ...cached,
      stats: { ...cached.stats, year: 2024, activeYears: [2019, 2021, 2024] },
    };
    expect(yearList(2026, w2024, undefined)).toEqual([2026, 2024, 2021, 2019]);
    expect(yearList(2026, w2024, cached)).toEqual([
      2026, 2025, 2024, 2021, 2019,
    ]);
    expect(yearList(2026)).toEqual([2026]);
    // Nothing after this year, nothing twice.
    expect(
      yearList(2026, {
        ...cached,
        stats: { ...cached.stats, activeYears: [2026, 2027] },
      }),
    ).toEqual([2026]);
  });
});

describe('GET /host/wrapped', () => {
  it('renders a cached Wrapped without asking for a token or Meetup', async () => {
    const h = await harness();
    await writeWrapped(h.wrappedCache, USER, 2026, cached, NOW);
    const sid = await signInWithDiscord(h.req);
    const res = await h.req.get('/host/wrapped?year=2026').set('Cookie', sid);
    expect(res.status).toBe(200);
    const text = strip(res.text);
    expect(text).toContain('1.5 Gen Wrapped 2026');
    expect(text).toContain('12');
    expect(text).toContain('40');
    expect(text).toContain('Food &amp; drink');
    expect(text).toContain('July');
    expect(text).toMatch(/Longest streak \(months\)<\/dt> <dd> ?5 ?<\/dd>/);
    expect(text).toContain('hosted 1 event');
    expect(text).toContain('Saturday Hike &lt;b&gt;');
    expect(text).toContain('href="https://www.meetup.com/e/1/"');
    expect(text).toContain('Mar 2, 2024');
    // Year picker: this year and the earlier active years.
    expect(text).toContain('href="/host/wrapped?year=2025"');
    expect(text).toContain('href="/host/wrapped?year=2024"');
    expect(text).toContain('aria-current="page">2026');
    expect(text).toContain(
      'A past year is built on the same once-an-hour limit',
    );
    expect(h.deps.memberToken).not.toHaveBeenCalled();
    expect(h.meetup.getSelfPastRsvpEvents).not.toHaveBeenCalled();
    expect(res.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
  });

  it('names linked, present companions by display name and counts the rest', async () => {
    const h = await harness();
    await writeWrapped(h.wrappedCache, USER, 2026, cached, NOW);
    const sid = await signInWithDiscord(h.req);
    const text = strip(
      (await h.req.get('/host/wrapped').set('Cookie', sid)).text,
    );
    expect(text).toContain('<bdi>Linked &lt;Pal&gt;</bdi>');
    expect(text).toContain('4 events');
    // d-gone could not be named: folded into the count (5 + 1).
    expect(text).toContain('6 other members');
    expect(text).not.toContain('d-gone');
    // The Discord id appears only as the profile link they consented to by linking.
    expect(
      text.replace(/href="https:\/\/discord\.com\/users\/d-linked"/g, ''),
    ).not.toContain('d-linked');
  });

  it('reads a year with no events as a quiet one', async () => {
    const h = await harness();
    await writeWrapped(h.wrappedCache, USER, 2025, quiet, NOW);
    const sid = await signInWithDiscord(h.req);
    const text = strip(
      (await h.req.get('/host/wrapped?year=2025').set('Cookie', sid)).text,
    );
    expect(text).toContain('1.5 Gen Wrapped 2025');
    expect(text).toMatch(/quiet year/i);
    expect(text).toContain('40');
    expect(text).toContain('Nobody yet');
    expect(text).not.toContain('Hosting');
  });

  it('builds on a miss with the stored member token, caches it and spends the shared slot', async () => {
    const h = await harness();
    const sid = await signInWithDiscord(h.req);
    const res = await h.req.get('/host/wrapped?year=2026').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(h.deps.memberToken).toHaveBeenCalledWith(USER);
    expect(h.deps.meetupClient).toHaveBeenCalledWith('member-token');
    const text = strip(res.text);
    expect(text).toContain('1.5 Gen Wrapped 2026');
    expect(text).toContain('Events in 2026</dt> <dd>2</dd>');
    // The Discord command's key, so /wrapped serves this copy next.
    const stored = await readWrapped(h.wrappedCache, USER, 2026, ME);
    expect(stored?.stats.attendedThisYear).toBe(2);
    expect(
      h.wrappedCache.ttls.get(wrappedCacheKey(USER, 2026)),
    ).toBeGreaterThan(86400);
    // The same hourly slot /wrapped takes: a Discord build now is refused.
    expect(h.deps.limiter.take(USER)).toBe(false);
    expect(h.wrappedCache.values.has(buildingKey(USER, 2026))).toBe(false);
  });

  it("never lets an unlinked attendee's Meetup name or id reach the page or the cache", async () => {
    const h = await harness();
    const sid = await signInWithDiscord(h.req);
    const res = await h.req.get('/host/wrapped?year=2026').set('Cookie', sid);
    const everything =
      res.text + JSON.stringify([...h.wrappedCache.values.values()]);
    expect(everything).not.toContain(GHOST.name);
    expect(everything).not.toContain(GHOST.id);
    expect(everything).not.toContain(LINKED.name);
    expect(res.text).toContain('Linked &lt;Pal&gt;');
  });

  it('shows the hourly limit when the slot was already spent (as by Discord), without Meetup', async () => {
    const h = await harness();
    h.deps.limiter.take(USER);
    const sid = await signInWithDiscord(h.req);
    const res = await h.req.get('/host/wrapped?year=2026').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('less than an hour ago');
    expect(res.text).toContain('60 minutes');
    expect(h.meetup.getEventRsvps).not.toHaveBeenCalled();
    expect(await readWrapped(h.wrappedCache, USER, 2026)).toBeUndefined();
  });

  it('says a build is already under way when the lease is held', async () => {
    const h = await harness();
    await h.wrappedCache.set(buildingKey(USER, 2026), 'x');
    const sid = await signInWithDiscord(h.req);
    const res = await h.req.get('/host/wrapped').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('already being built');
    expect(h.meetup.getSelfPastRsvpEvents).not.toHaveBeenCalled();
  });

  it('stops waiting at the deadline, and the build still lands in the cache', async () => {
    const h = await harness({
      meetup: fakeMeetup({ delayMs: 60 }),
      deadlineMs: 5,
    });
    const sid = await signInWithDiscord(h.req);
    const res = await h.req.get('/host/wrapped?year=2026').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Still building');
    expect(await readWrapped(h.wrappedCache, USER, 2026)).toBeUndefined();
    await vi.waitFor(async () => {
      expect(await readWrapped(h.wrappedCache, USER, 2026, ME)).toBeDefined();
    });
    expect(h.wrappedCache.values.has(buildingKey(USER, 2026))).toBe(false);
  });

  it('a Meetup failure is a 503 with safe text, an alert, and the slot given back', async () => {
    const SENTINEL = 'RAW-MEETUP-BODY-7f3a';
    const h = await harness({
      meetup: fakeMeetup({
        rsvpsError: new ClientError(
          {
            status: 500,
            headers: new Headers(),
            body: SENTINEL,
            errors: [{ message: SENTINEL }],
          } as never,
          { query: 'q' },
        ),
      }),
    });
    const sid = await signInWithDiscord(h.req);
    const res = await h.req.get('/host/wrapped?year=2026').set('Cookie', sid);
    expect(res.status).toBe(503);
    expect(res.text).toContain('Could not build your Wrapped right now');
    expect(res.text).not.toContain(SENTINEL);
    expect(h.alert).toHaveBeenCalledTimes(1);
    const alertText = JSON.stringify(h.alert.mock.calls[0]);
    expect(alertText).toContain('HTTP 500');
    expect(alertText).not.toContain(SENTINEL);
    expect(h.deps.limiter.take(USER)).toBe(true);
    expect(h.wrappedCache.values.has(buildingKey(USER, 2026))).toBe(false);
  });

  it('tells a member whose token is for another Meetup account to sign in with Meetup again', async () => {
    const h = await harness({ meetup: fakeMeetup({ meetupId: 'someone' }) });
    const sid = await signInWithDiscord(h.req);
    const res = await h.req.get('/host/wrapped').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('is not the one linked');
    expect(res.text).toContain('href="/host/auth/meetup/start"');
    expect(h.deps.limiter.take(USER)).toBe(true);
    expect(await readWrapped(h.wrappedCache, USER, 2026)).toBeUndefined();
  });

  it('with no stored Meetup token, offers the Meetup sign-in instead of building', async () => {
    const h = await harness({ hasToken: false });
    const sid = await signInWithDiscord(h.req);
    const res = await h.req.get('/host/wrapped').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/host/auth/meetup/start"');
    expect(res.text).toContain('/wrapped');
    expect(h.meetup.getSelfPastRsvpEvents).not.toHaveBeenCalled();
    expect(h.deps.limiter.take(USER)).toBe(true);
  });

  it('a host signed in with Meetup and not linked gets the link nudge, not a build', async () => {
    const h = await harness({
      resolve: { ...HOST, discordUserId: undefined },
    });
    const sid = await signInWithMeetup(h.req);
    const res = await h.req.get('/host/wrapped').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('linked members');
    expect(res.text).toContain('action="/host/link/discord"');
    expect(h.deps.memberToken).not.toHaveBeenCalled();
  });
});

describe('GET /host/wrapped deeper sections', () => {
  async function deepPage(copy: CachedWrapped = deep) {
    const h = await harness();
    await writeWrapped(h.wrappedCache, USER, 2026, copy, NOW);
    const sid = await signInWithDiscord(h.req);
    const res = await h.req.get('/host/wrapped?year=2026').set('Cookie', sid);
    expect(res.status).toBe(200);
    // Whitespace between tags and inside tag ends is formatting, not content.
    const text = strip(res.text)
      .replace(/>\s+</g, '><')
      .replace(/\s+>/g, '>')
      .replace(/<summary>\s+/g, '<summary>')
      .replace(/\s+<\/summary>/g, '</summary>');
    return { h, text, raw: res.text };
  }

  it('shows three companions with profile links and a "Show all" expander for the rest', async () => {
    const { text } = await deepPage();
    const section = text.slice(text.indexOf('Went with the most'));
    const before = section.slice(0, section.indexOf('<details'));
    expect(
      before.match(
        /href="https:\/\/discord\.com\/users\/2000000000000000\d\d"/g,
      ),
    ).toHaveLength(3);
    expect(before).toContain(
      'href="https://discord.com/users/200000000000000001"',
    );
    expect(before).toContain('<bdi>Pal 01</bdi>');
    expect(before).toContain('10 events');
    expect(section).toContain('<summary>Show all 9</summary>');
    expect(section).toContain(
      'href="https://discord.com/users/200000000000000009"',
    );
    // Five never named plus d-10, who could not be resolved.
    expect(section).toContain('6 other members');
    expect(section).not.toContain('200000000000000010');
  });

  it('lists the events shared with the top companion in an expander', async () => {
    const { text } = await deepPage();
    expect(text).toContain(
      '<summary>Together with <bdi>Pal 01</bdi> (2 events)</summary>',
    );
    expect(text).toContain('Pho Night');
    expect(text).toContain('href="https://www.meetup.com/e/j3/"');
  });

  it("lists the busiest month's events with dates and links", async () => {
    const { text } = await deepPage();
    expect(text).toContain('June (3 events)');
    expect(text).toContain('<summary>Events that month (3)</summary>');
    expect(text).toContain('<time>Jun 3, 2026</time>');
    expect(text).toContain('href="https://www.meetup.com/e/j1/"');
  });

  it('renders unsafe event URLs as text', async () => {
    const { raw } = await deepPage();
    expect(raw).not.toContain('javascript:');
    expect(raw).toContain('Sneaky');
  });

  it('ranks hosted events with attendance and the all-time best', async () => {
    const { text } = await deepPage();
    expect(text).toContain('hosted 6 events');
    expect(text).toContain('Most attended this year');
    expect(text).toMatch(/Big Hike<\/bdi><\/a>\s*\(31 RSVPs\)/);
    expect(text).not.toContain('going');
    expect(text).not.toContain('attended)');
    expect(text.indexOf('Big Hike')).toBeLessThan(text.indexOf('Picnic'));
    expect(text).toContain('Legendary Potluck');
    expect(text).toContain('(58 RSVPs)');
  });

  it('expands each top type to its first events and the early cohort', async () => {
    const { text } = await deepPage();
    expect(text).toContain(
      '<summary>Your first 10 food &amp; drink events</summary>',
    );
    expect(text).toContain('Dinner 0');
    expect(text).toContain('href="https://www.meetup.com/e/f9/"');
    expect(text).toContain(
      '<summary>Still around from your early cohort (7)</summary>',
    );
    const cohort = text.slice(
      text.indexOf('Still around from your early cohort'),
    );
    const firstFive = cohort.slice(
      0,
      cohort.indexOf('<summary>Show all 7</summary>'),
    );
    expect(
      firstFive.match(
        /href="https:\/\/discord\.com\/users\/30000000000000000\d"/g,
      ),
    ).toHaveLength(5);
    expect(firstFive).toContain('7 early events, 2 this year');
    expect(cohort).toContain(
      'href="https://discord.com/users/300000000000000007"',
    );
    expect(cohort).toContain('and 3 other members');
    expect(text).toContain('<summary>Your first 1 games event</summary>');
  });

  it('a Discord id that is not a snowflake gets no profile link, only the name', async () => {
    const { text } = await deepPage({
      ...deep,
      companions: {
        named: [{ discordUserId: 'd-linked', sharedCount: 3 }],
        otherCount: 0,
      },
    });
    expect(text).toContain('<bdi>Linked &lt;Pal&gt;</bdi>');
    expect(text).not.toContain('discord.com/users/d-linked');
  });

  it('folds an unresolvable top companion', async () => {
    const copy: CachedWrapped = {
      ...deep,
      companions: {
        ...deep.companions,
        named: deep.companions.named.map((c, i) => {
          return i === 0 ? { ...c, discordUserId: '200000000000000010' } : c;
        }),
      },
    };
    const { text } = await deepPage(copy);
    expect(text).not.toContain('Together with');
    // Five never named, plus the two d-10 entries that could not be resolved.
    expect(text).toContain('7 other members');
  });

  it('a quiet year has no expanders', async () => {
    const { text } = await deepPage({
      ...quiet,
      stats: { ...quiet.stats, year: 2026 },
    });
    expect(text).not.toContain('<details');
    expect(text).not.toContain('Hosting');
  });

  it("never lets an unlinked attendee's Meetup name or id reach the deeper sections or the cache", async () => {
    const { raw, h } = await deepPage();
    const everything =
      raw + JSON.stringify([...h.wrappedCache.values.values()]);
    expect(everything).not.toContain(GHOST.name);
    expect(everything).not.toContain(GHOST.id);
    expect(everything).not.toContain(LINKED.name);
  });
});

describe('after a rebuild that did not build', () => {
  it('a ?notice=failed page builds again when reloaded, as it says to', async () => {
    const meetup = fakeMeetup();
    meetup.getEventRsvps.mockRejectedValueOnce(new Error('one-off'));
    const h = await harness({ meetup });
    const sid = await signInWithDiscord(h.req);
    const failed = await h.req
      .get('/host/wrapped?year=2026')
      .set('Cookie', sid);
    expect(failed.status).toBe(503);
    const again = await h.req
      .get('/host/wrapped?year=2026&notice=failed')
      .set('Cookie', sid);
    expect(again.status).toBe(200);
    expect(strip(again.text)).toContain('Events in 2026</dt> <dd>2</dd>');
    expect(await readWrapped(h.wrappedCache, USER, 2026, ME)).toBeDefined();
  });

  it('a ?notice=rate-limited page does not try again', async () => {
    const h = await harness();
    h.deps.limiter.take(USER);
    const sid = await signInWithDiscord(h.req);
    const res = await h.req
      .get('/host/wrapped?year=2026&notice=rate-limited&retry=30')
      .set('Cookie', sid);
    expect(res.status).toBe(200);
    // From the limiter, not the query: a hand-typed URL cannot say 0 or 30.
    expect(res.text).toContain('60 minutes');
    expect(h.meetup.getSelfPastRsvpEvents).not.toHaveBeenCalled();
  });

  it('the year picker ignores a this-year copy built for another Meetup account', async () => {
    const h = await harness();
    await writeWrapped(
      h.wrappedCache,
      USER,
      2024,
      {
        ...cached,
        stats: { ...cached.stats, year: 2024, activeYears: [2024] },
      },
      NOW,
    );
    await writeWrapped(
      h.wrappedCache,
      USER,
      2026,
      {
        ...cached,
        meetupId: 'someone-else',
        stats: { ...cached.stats, activeYears: [2019, 2024, 2026] },
      },
      NOW,
    );
    const sid = await signInWithDiscord(h.req);
    const res = await h.req.get('/host/wrapped?year=2024').set('Cookie', sid);
    expect(res.text).toContain('aria-current="page">2024');
    expect(res.text).not.toContain('?year=2019');
  });
});

describe('the queue for throttled requests', () => {
  const rebuild = (h: Harness, sid: string, year = '2026') =>
    h.req
      .post('/host/wrapped/rebuild')
      .set('Cookie', sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: h.csrf(), year });

  it('a throttled rebuild with nothing cached is queued and the page says when', async () => {
    const h = await harness({ queue: true });
    await h.wrappedCache.set(NEXT_TICK_KEY, '2026-12-10T20:05:00.000Z');
    h.deps.limiter.take(USER);
    const sid = await signInWithDiscord(h.req);

    const res = await rebuild(h, sid);

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/host/wrapped?year=2026&notice=queued');
    expect((await h.store.position(USER))?.row).toMatchObject({
      meetupId: ME,
      year: 2026,
    });
    const shown = strip(
      (await h.req.get(res.headers.location).set('Cookie', sid)).text,
    );
    expect(shown).toContain('Queued — it&#39;ll be ready by about 12:05 pm.');
    expect(shown).toContain('less than an hour ago');
    expect(h.meetup.getSelfPastRsvpEvents).toHaveBeenCalledTimes(1);
  });

  it('says which year is already queued', async () => {
    const h = await harness({ queue: true });
    await h.store.enqueue({ discordUserId: USER, meetupId: ME, year: 2024 });
    h.deps.limiter.take(USER);
    const sid = await signInWithDiscord(h.req);

    const res = await rebuild(h, sid);

    expect(res.headers.location).toBe(
      '/host/wrapped?year=2026&notice=already-queued',
    );
    const shown = strip(
      (await h.req.get(res.headers.location).set('Cookie', sid)).text,
    );
    expect(shown).toContain(
      'You already have 2024 queued; it&#39;ll be ready by about',
    );
  });

  it('a throttled rebuild with a cached copy is not queued', async () => {
    const h = await harness({ queue: true });
    await writeWrapped(h.wrappedCache, USER, 2026, cached, NOW);
    h.deps.limiter.take(USER);
    const sid = await signInWithDiscord(h.req);

    const res = await rebuild(h, sid);

    expect(res.headers.location).toBe(
      '/host/wrapped?year=2026&notice=rate-limited',
    );
    expect(await h.store.queueLength()).toBe(0);
  });

  it('a reload while queued and limited shows the notice without building', async () => {
    const h = await harness({ queue: true });
    await h.store.enqueue({ discordUserId: USER, meetupId: ME, year: 2026 });
    h.deps.limiter.take(USER);
    const sid = await signInWithDiscord(h.req);

    const res = await h.req.get('/host/wrapped?year=2026').set('Cookie', sid);

    expect(res.status).toBe(200);
    expect(strip(res.text)).toContain('Queued — it&#39;ll be ready by about');
    expect(h.deps.memberToken).not.toHaveBeenCalled();
  });

  it('a reload with a free slot builds and drops the row', async () => {
    const h = await harness({ queue: true });
    await h.store.enqueue({ discordUserId: USER, meetupId: ME, year: 2026 });
    const sid = await signInWithDiscord(h.req);

    const res = await h.req.get('/host/wrapped?year=2026').set('Cookie', sid);

    expect(res.status).toBe(200);
    expect(strip(res.text)).toContain('Events in 2026</dt> <dd>2</dd>');
    expect(await h.store.queueLength()).toBe(0);
  });

  it('without a queue the hourly limit reads as before', async () => {
    const h = await harness();
    h.deps.limiter.take(USER);
    const sid = await signInWithDiscord(h.req);

    const res = await rebuild(h, sid);

    expect(res.headers.location).toBe(
      '/host/wrapped?year=2026&notice=rate-limited',
    );
  });
});

describe('POST /host/wrapped/rebuild', () => {
  it('rebuilds past the cached copy and comes back to the page', async () => {
    const h = await harness();
    await writeWrapped(h.wrappedCache, USER, 2026, cached, NOW);
    const sid = await signInWithDiscord(h.req);
    const res = await h.req
      .post('/host/wrapped/rebuild')
      .set('Cookie', sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: h.csrf(), year: '2026' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/host/wrapped?year=2026');
    const stored = await readWrapped(h.wrappedCache, USER, 2026, ME);
    expect(stored?.stats.attendedThisYear).toBe(2);
    expect(h.deps.limiter.take(USER)).toBe(false);
  });

  it('carries a non-render outcome back as a notice', async () => {
    const h = await harness();
    h.deps.limiter.take(USER);
    await writeWrapped(h.wrappedCache, USER, 2026, cached, NOW);
    const sid = await signInWithDiscord(h.req);
    const res = await h.req
      .post('/host/wrapped/rebuild')
      .set('Cookie', sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: h.csrf(), year: '2026' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(
      '/host/wrapped?year=2026&notice=rate-limited',
    );
    const shown = await h.req
      .get('/host/wrapped?year=2026&notice=rate-limited')
      .set('Cookie', sid);
    expect(shown.text).toContain('less than an hour ago');
    expect(shown.text).toContain('60 minutes');
    // The cached copy still shows under the notice.
    expect(shown.text).toContain('1.5 Gen Wrapped 2026');
  });

  it('a rebuild without the CSRF token is refused by the guard', async () => {
    const h = await harness();
    const sid = await signInWithDiscord(h.req);
    const res = await h.req
      .post('/host/wrapped/rebuild')
      .set('Cookie', sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ year: '2026' });
    expect(res.status).toBe(403);
    expect(h.meetup.getSelfPastRsvpEvents).not.toHaveBeenCalled();
  });
});

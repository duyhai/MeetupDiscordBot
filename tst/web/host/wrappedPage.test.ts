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
    getGroupEvents: vi.fn(() =>
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
      { type: 'food', count: 5 },
      { type: 'games', count: 4 },
    ],
    hosting: { thisYear: 1, allTime: 3 },
    busiestMonth: { month: 6, count: 4 },
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
}

async function harness({
  meetup = fakeMeetup(),
  hasToken = true,
  deadlineMs = 2000,
  resolve,
}: {
  meetup?: ReturnType<typeof fakeMeetup>;
  hasToken?: boolean;
  deadlineMs?: number;
  resolve?: unknown;
} = {}): Promise<Harness> {
  const wrappedCache = new FakeCache();
  const alert = vi.fn().mockResolvedValue(true);
  const clock = { now: NOW.getTime() };
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
      return discordUserId === 'd-linked' ? 'Linked <Pal>' : undefined;
    },
    limiter: createBuildLimiter(() => clock.now),
    alert,
    groupId: GROUP,
    now: () => new Date(clock.now),
    deadlineMs,
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
  return { req, cache, wrappedCache, meetup, deps, alert, csrf };
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
    expect(text).toContain('5 months');
    expect(text).toContain('hosted 1 event');
    expect(text).toContain('Saturday Hike &lt;b&gt;');
    expect(text).toContain('href="https://www.meetup.com/e/1/"');
    expect(text).toContain('Mar 2, 2024');
    // Year picker: this year and the earlier active years.
    expect(text).toContain('href="/host/wrapped?year=2025"');
    expect(text).toContain('href="/host/wrapped?year=2024"');
    expect(text).toContain('aria-current="page">2026');
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
    expect(text).not.toContain('d-linked');
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
      '/host/wrapped?year=2026&notice=rate-limited&retry=60',
    );
    const shown = await h.req
      .get('/host/wrapped?year=2026&notice=rate-limited&retry=60')
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

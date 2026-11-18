import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostResolution } from '../../../src/lib/hosts/eligibility.js';
import { LeaderboardDeps } from '../../../src/lib/leaderboard/leaderboard.js';
import {
  LeaderboardEvent,
  Medal,
} from '../../../src/lib/leaderboard/standings.js';
import { LeaderboardStore } from '../../../src/lib/repositories/postgresLeaderboardRepository.js';
import { SnapshotRun } from '../../../src/lib/repositories/postgresSnapshotRepository.js';
import { createHostRouter } from '../../../src/web/host/hostRouter.js';
import {
  leaderboardMonth,
  registerLeaderboardPage,
} from '../../../src/web/host/leaderboardPage.js';
import { clientFor, listen } from '../../setup/loopbackServer.js';
import {
  DISCORD_USER,
  closeServers,
  makeHostDeps,
  signInWithMeetup,
} from './hostHarness.js';

afterEach(closeServers);

// Tuesday 2026-11-17, 10:00 Pacific.
const NOW = new Date('2026-11-17T18:00:00Z');
const HOSTILE = '<script>alert(1)</script>"><img src=x>';

let seq = 0;
/** An event on a Pacific day. */
const ev = (
  day: string,
  hostIds: string[],
  title = 'Games',
): LeaderboardEvent => {
  seq += 1;
  return { id: String(seq), title, status: 'PAST', hostIds, day };
};

/** The table's rows as [place, host, events], tags stripped. */
const rowsOf = (text: string): string[][] => {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(text)?.[1] ?? '';
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
    ['Place', 'Host', 'Events'].map((label) =>
      (
        new RegExp(`data-label="${label}">([\\s\\S]*?)</td>`).exec(
          row[1],
        )?.[1] ?? ''
      )
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ),
  );
};

const RUN: SnapshotRun = {
  id: 1,
  trigger: 'job',
  kind: 'incremental',
  startedAt: new Date('2026-11-17T08:00:00Z'),
  finishedAt: new Date('2026-11-17T09:00:00Z'),
  listedAt: new Date('2026-11-17T08:05:00Z'),
  eventsListed: 1,
  eventsFetched: 1,
  rsvpsStored: 1,
  failed: 0,
  requests: 1,
  lastError: undefined,
};

function fakeStore(
  events: LeaderboardEvent[],
  names: Record<string, string>,
): LeaderboardStore & {
  stored: Medal[];
  months: Set<string>;
  mocks: Record<'hostedEvents' | 'award', ReturnType<typeof vi.fn>>;
} {
  const stored: Medal[] = [];
  const months = new Set<string>();
  const mocks = {
    hostedEvents: vi.fn(async () => events),
    award: vi.fn(async (list: Parameters<LeaderboardStore['award']>[0]) => {
      list.forEach(({ month, medals }) => {
        if (!months.has(month)) {
          months.add(month);
          stored.push(...medals);
        }
      });
    }),
  };
  return {
    stored,
    months,
    mocks,
    hostedEvents: mocks.hostedEvents,
    hostNames: vi.fn(async () => new Map(Object.entries(names))),
    medals: vi.fn(async () => [...stored]),
    awardedMonths: vi.fn(async () => new Set(months)),
    award: mocks.award,
  };
}

async function app(
  store: LeaderboardStore,
  overrides: Partial<LeaderboardDeps> = {},
  resolve?: HostResolution,
) {
  const { deps } = makeHostDeps({
    ...(resolve ? { resolve: vi.fn().mockResolvedValue(resolve) } : {}),
    pages: (router) =>
      registerLeaderboardPage(router, {
        store: async () => store,
        snapshot: async () => ({
          hasFinishedFull: async () => true,
          lastFinishedRun: async () => RUN,
          lastCompleteListing: async () => RUN.listedAt,
        }),
        now: () => NOW,
        ...overrides,
      }),
  });
  const server = await listen(express().use('/host', createHostRouter(deps)));
  const req = clientFor(server);
  return { req, sid: await signInWithMeetup(req) };
}

const EVENTS = [
  // October: 1 hosts 3 (one co-hosted with 2), 2 hosts 3, 3 hosts 1.
  {
    ...ev('2026-10-02', ['1', '2']),
    place: { latE2: 4761, lonE2: -12233, city: 'Seattle' },
  },
  {
    ...ev('2026-10-03', ['1']),
    place: { latE2: 4761, lonE2: -12233, city: HOSTILE },
  },
  ev('2026-10-04', ['1']),
  ev('2026-10-09', ['2']),
  ev('2026-10-16', ['2']),
  ev('2026-10-20', ['3']),
  ev('2026-10-21', ['3'], 'Hike (cancelled)'),
  // November so far: 4242 (the signed-in host) on three days in a row.
  ev('2026-11-14', ['4242']),
  ev('2026-11-15', ['4242']),
  ev('2026-11-16', ['4242', '1']),
];
const NAMES = { '1': 'Bea', '2': HOSTILE, '3': 'Cy', '4242': 'Ann' };

describe('host leaderboard', () => {
  it('shows this month so far, with no medals, streaks with text alternatives, and the tab', async () => {
    const store = fakeStore(EVENTS, NAMES);
    const { req, sid } = await app(store);
    const res = await req.get('/host/leaderboard').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/host/leaderboard" aria-current="page"');
    expect(res.text).toContain('November 2026');
    expect(res.text).toContain('Standings so far');
    expect(res.text).toContain(
      '<strong><a href="/host/hosts/4242"><bdi>Ann</bdi></a></strong>',
    );
    expect(res.text).toContain('<a href="/host/hosts/1"><bdi>Bea</bdi></a>');
    // 💎 weekly first (the prestige streak), then 🔥 daily.
    const weekly = res.text.search(
      /aria-label="Weekly hosting streak: 2 weeks"[^>]*>\s*💎/,
    );
    const daily = res.text.search(
      /aria-label="Daily hosting streak: 3 days"[^>]*>\s*🔥/,
    );
    expect(weekly).toBeGreaterThan(0);
    expect(daily).toBeGreaterThan(weekly);
    expect(res.text).not.toContain('Gold medal, November');
    // The best streak shows in the month view too, not only on hover.
    expect(res.text).toContain('Best: 1 week in a row, 3 days in a row');
    // Every closed month was awarded on the way, October's medals stored.
    expect(store.months).toEqual(new Set(['2026-10']));
  });

  it('a closed month shows final standings with shared places and stored medals, escaped', async () => {
    const store = fakeStore(EVENTS, NAMES);
    const { req, sid } = await app(store);
    const res = await req
      .get('/host/leaderboard?month=2026-10')
      .set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Final standings');
    expect(res.text.match(/Gold medal, October 2026/g)).toHaveLength(4); // 2 × (aria-label + title)
    expect(res.text).toContain('Bronze medal, October 2026');
    expect(res.text).not.toContain('Silver medal, October 2026');
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).toContain('&lt;script&gt;');
    expect(store.stored.map((m) => [m.memberId, m.place])).toEqual([
      ['1', 1],
      ['2', 1],
      ['3', 3],
    ]);
  });

  it('an awarded month shows the stored medalists as awarded, then the rest live', async () => {
    const store = fakeStore(EVENTS, NAMES);
    // Awarded off an earlier listing: Cy won with 9; corrections since.
    store.months.add('2026-10');
    store.stored.push({ month: '2026-10', memberId: '3', place: 1, events: 9 });
    const { req, sid } = await app(store);
    const res = await req
      .get('/host/leaderboard?month=2026-10')
      .set('Cookie', sid);
    expect(store.mocks.award).not.toHaveBeenCalled();
    expect(rowsOf(res.text)).toEqual([
      ['1', 'Cy', '9'],
      // Tied live on 3: listed by name ("<" sorts before "B").
      [
        '2',
        '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img src=x&gt;',
        '3',
      ],
      ['2', 'Bea', '3'],
    ]);
    expect(res.text.match(/Gold medal, October 2026/g)).toHaveLength(2);
    expect(res.text).toContain('are kept');
  });

  it('a closed month not yet awarded says why, accurately', async () => {
    const store = fakeStore(EVENTS, NAMES);
    const { req, sid } = await app(store, {
      snapshot: async () => ({
        hasFinishedFull: async () => true,
        lastFinishedRun: async () => RUN,
        // The latest listing was short: nothing is awarded off it.
        lastCompleteListing: async () => undefined,
      }),
    });
    const res = await req
      .get('/host/leaderboard?month=2026-10')
      .set('Cookie', sid);
    expect(store.mocks.award).not.toHaveBeenCalled();
    expect(res.text).toContain('complete update from');
    expect(res.text).not.toContain('<th>Medal</th>');

    const failing = fakeStore(EVENTS, NAMES);
    failing.award = vi.fn().mockRejectedValue(new Error('lock timeout'));
    const two = await app(failing);
    const again = await two.req
      .get('/host/leaderboard?month=2026-10')
      .set('Cookie', two.sid);
    expect(again.text).toContain('could not be awarded just now');
  });

  it('ignores a garbage or repeated ?month= and needs a signed-in host', async () => {
    const store = fakeStore(EVENTS, NAMES);
    const { req, sid } = await app(store);
    for (const q of [
      'month=2026-10&month=2026-09',
      'month=%3Cx%3E',
      'month[a]=1',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await req.get(`/host/leaderboard?${q}`).set('Cookie', sid);
      expect(res.status).toBe(200);
      expect(res.text).toContain('November 2026');
    }
    const anonymous = await req.get('/host/leaderboard');
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.location).toContain('/host/login');
  });

  it('the Hall of fame ranks lifetime events with medal tallies and best streaks', async () => {
    const store = fakeStore(EVENTS, NAMES);
    const { req, sid } = await app(store);
    const res = await req.get('/host/leaderboard?view=all').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      '<strong aria-current="page">Hall of fame</strong>',
    );
    expect(res.text).toContain('4 hosts, 9 events.');
    expect(res.text).toContain('1 gold medal');
    expect(res.text).toContain('Best: 2 weeks in a row, 3 days in a row');
    // The hostile name (2) and Ann tie on 3 lifetime events: one place.
    expect(rowsOf(res.text).map((r) => [r[0], r[2]])).toEqual([
      ['1', '4'],
      ['2', '3'],
      ['2', '3'],
      ['4', '1'],
    ]);
  });

  it('an out-of-range month falls back to this month', () => {
    expect(leaderboardMonth('2026-12', '2026-01', '2026-11')).toBe('2026-11');
    expect(leaderboardMonth('2025-12', '2026-01', '2026-11')).toBe('2026-11');
    expect(leaderboardMonth('2026-13', '2026-01', '2026-11')).toBe('2026-11');
    expect(leaderboardMonth('2026-03', '2026-01', '2026-11')).toBe('2026-03');
  });

  it('says the leaderboard is being built before the first full pull, reading nothing else', async () => {
    const store = fakeStore(EVENTS, NAMES);
    const { req, sid } = await app(store, {
      snapshot: async () => ({
        hasFinishedFull: async () => false,
        lastFinishedRun: async () => undefined,
        lastCompleteListing: async () => undefined,
      }),
    });
    const res = await req.get('/host/leaderboard').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('still being built');
    expect(store.mocks.hostedEvents).not.toHaveBeenCalled();
  });

  it('a snapshot read failure is a 503 page; an award failure still shows the page', async () => {
    const broken = fakeStore(EVENTS, NAMES);
    broken.hostedEvents = vi.fn().mockRejectedValue(new Error('db down'));
    const one = await app(broken);
    const res = await one.req.get('/host/leaderboard').set('Cookie', one.sid);
    expect(res.status).toBe(503);

    const store = fakeStore(EVENTS, NAMES);
    store.award = vi.fn().mockRejectedValue(new Error('lock timeout'));
    const two = await app(store);
    const ok = await two.req
      .get('/host/leaderboard?month=2026-10')
      .set('Cookie', two.sid);
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain('Gold medal');
  });

  it('waits at most the award budget for a slow first backfill', async () => {
    const store = fakeStore(EVENTS, NAMES);
    let finish: () => void = () => {};
    store.award = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { req, sid } = await app(store, { awardBudgetMs: 20 });
    const res = await req.get('/host/leaderboard').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Standings so far');
    finish();
  });

  it('shows the standings without medals when medals cannot be read', async () => {
    for (const fail of ['awardedMonths', 'medals'] as const) {
      const store = fakeStore(EVENTS, NAMES);
      store[fail] = vi.fn().mockRejectedValue(new Error('db down'));
      // eslint-disable-next-line no-await-in-loop -- two cases in turn
      const { req, sid } = await app(store);
      // eslint-disable-next-line no-await-in-loop
      const res = await req
        .get('/host/leaderboard?month=2026-10')
        .set('Cookie', sid);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Medals cannot be loaded right now');
      expect(res.text).toContain('<bdi>Bea</bdi>');
      expect(res.text).not.toContain('Gold medal');
    }
  });

  it('is not shown to a member who never hosted', async () => {
    const store = fakeStore(EVENTS, NAMES);
    const { req, sid } = await app(
      store,
      {},
      {
        kind: 'member',
        meetupMemberId: '4242',
        discordUserId: DISCORD_USER.id,
      },
    );
    const home = await req.get('/host/wrapped').set('Cookie', sid);
    expect(home.text).not.toContain('href="/host/leaderboard"');
    const res = await req.get('/host/leaderboard').set('Cookie', sid);
    expect(res.status).toBe(403);
    expect(store.mocks.hostedEvents).not.toHaveBeenCalled();
  });

  it('the Hall of fame draws a map from our own Leaflet, with OSM tiles allowed on that page only', async () => {
    const store = fakeStore(EVENTS, NAMES);
    const { req, sid } = await app(store);
    const all = await req.get('/host/leaderboard?view=all').set('Cookie', sid);
    expect(all.text).toContain('data-map-cells="[[47.61,-122.33,2]]"');
    expect(all.text).toMatch(
      /<script nonce="[^"]+" src="\/host\/assets\/leaflet\.js\?v=1\.9\.4"><\/script>/,
    );
    expect(all.text).toMatch(
      /<link rel="stylesheet" href="\/host\/assets\/leaflet\.css\?v=1\.9\.4" nonce="[^"]+" \/>/,
    );
    // The city list says the same for no-JS and screen readers; escaped.
    expect(all.text).toContain('<li><bdi>Seattle</bdi>: 1 event</li>');
    expect(all.text).toContain('<bdi>&lt;script&gt;alert(1)&lt;/script&gt;');
    // The other counted events predate the venue fields.
    expect(all.text).toContain(
      'Venue data for 7 events is still being collected.',
    );
    expect(all.text).toContain('role="region"');
    const csp = String(all.headers['content-security-policy']);
    // The host CSP (Meetup photos, same-origin fetch) plus the tile host.
    expect(csp).toContain(
      "img-src 'self' https://secure.meetupstatic.com https://tile.openstreetmap.org;",
    );
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toMatch(/script-src 'nonce-[^']+';/);

    const month = await req.get('/host/leaderboard').set('Cookie', sid);
    expect(String(month.headers['content-security-policy'])).not.toContain(
      'tile.openstreetmap.org',
    );
    expect(month.text).not.toContain('leaflet.js');
  });

  it('serves Leaflet’s two files with their types, and nothing else under assets', async () => {
    const store = fakeStore(EVENTS, NAMES);
    const { req, sid } = await app(store);
    const js = await req
      .get('/host/assets/leaflet.js?v=1.9.4')
      .set('Cookie', sid)
      .set('Accept-Encoding', 'gzip');
    expect(js.status).toBe(200);
    expect(String(js.headers['content-type'])).toContain('text/javascript');
    expect(js.headers['content-encoding']).toBe('gzip');
    expect(String(js.headers['cache-control'])).toContain('immutable');
    expect(String(js.headers.vary)).toContain('Accept-Encoding');
    const plain = await req
      .get('/host/assets/leaflet.js')
      .set('Cookie', sid)
      .set('Accept-Encoding', 'identity');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.text).toContain('Leaflet');
    const css = await req.get('/host/assets/leaflet.css').set('Cookie', sid);
    expect(css.status).toBe(200);
    expect(String(css.headers['content-type'])).toContain('text/css');
    for (const name of ['leaflet.js.map', '..%2Fpackage.json', 'x.css']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await req.get(`/host/assets/${name}`).set('Cookie', sid);
      expect(res.status).toBe(404);
    }
    const anonymous = await req.get('/host/assets/leaflet.js');
    expect(anonymous.status).toBe(302);
  });
});

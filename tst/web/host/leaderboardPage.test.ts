import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostResolution } from '../../../src/lib/hosts/eligibility.js';
import { LeaderboardDeps } from '../../../src/lib/leaderboard/leaderboard.js';
import {
  LeaderboardEvent,
  Medal,
  Standing,
} from '../../../src/lib/leaderboard/standings.js';
import { LeaderboardStore } from '../../../src/lib/repositories/postgresLeaderboardRepository.js';
import { SnapshotRun } from '../../../src/lib/repositories/postgresSnapshotRepository.js';
import { createHostRouter } from '../../../src/web/host/hostRouter.js';
import {
  leaderboardMonth,
  registerLeaderboardPage,
  shortList,
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
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
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
    const seattle = { latE2: 4761, lonE2: -12233, city: HOSTILE };
    const events = [
      // 3 events from 3 hosts: drawn and named (escaped).
      { ...ev('2026-10-02', ['1']), place: seattle },
      { ...ev('2026-10-03', ['3']), place: seattle },
      { ...ev('2026-10-04', ['2']), place: seattle },
      // Before the venue fields: not collected yet.
      ev('2026-10-05', ['2']),
    ];
    const store = fakeStore(events, NAMES);
    const { req, sid } = await app(store);
    const all = await req.get('/host/leaderboard?view=all').set('Cookie', sid);
    expect(all.text).toContain(
      'data-map-cells="[[47.61,-122.33,1,&quot;up to 5 events&quot;]]"',
    );
    expect(all.text).toMatch(
      /<script nonce="[^"]+" src="\/host\/assets\/leaflet\.js\?v=1\.9\.4"><\/script>/,
    );
    expect(all.text).toMatch(
      /<link rel="stylesheet" href="\/host\/assets\/leaflet\.css\?v=1\.9\.4" nonce="[^"]+" \/>/,
    );
    // The city list says the same for no-JS and screen readers; escaped.
    expect(all.text).toContain(
      '<li><bdi>&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img src=x&gt;</bdi>: up to 5 events</li>',
    );
    expect(all.text).toContain(
      'Venue data for up to 5 events is still being collected.',
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

  it('Smallville: one host’s small home area is neither drawn nor named on the Hall of fame', async () => {
    const seattle = { latE2: 4761, lonE2: -12233, city: 'Seattle' };
    const smallville = { latE2: 4790, lonE2: -12250, city: 'Smallville' };
    const events = [
      { ...ev('2026-10-02', ['1']), place: seattle },
      { ...ev('2026-10-03', ['2']), place: seattle },
      { ...ev('2026-10-04', ['3']), place: seattle },
      // Host 9 hosts twice at home.
      { ...ev('2026-10-05', ['9']), place: smallville },
      { ...ev('2026-10-06', ['9']), place: smallville },
    ];
    const store = fakeStore(events, NAMES);
    const { req, sid } = await app(store);
    const all = await req.get('/host/leaderboard?view=all').set('Cookie', sid);
    expect(all.text).toContain(
      'data-map-cells="[[47.61,-122.33,1,&quot;up to 5 events&quot;]]"',
    );
    expect(all.text).not.toContain('47.9');
    expect(all.text).not.toContain('Smallville');
    expect(all.text).toContain(
      '<li>Elsewhere or unknown area: up to 5 events</li>',
    );
    expect(all.text).toContain(
      'Areas with fewer than 3 events, or mostly one host’s, are not drawn; their events are counted above.',
    );
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

  it('Layout 2: the lifetime table, then nine award boards, then the map, then the archive', async () => {
    const withAttendance = EVENTS.map((e, n) => ({ ...e, attendance: 5 + n }));
    const store = fakeStore(withAttendance, NAMES);
    const { req, sid } = await app(store);
    const res = await req.get('/host/leaderboard?view=all').set('Cookie', sid);
    expect(res.status).toBe(200);
    const at = (text: string) => res.text.indexOf(text);
    expect(at('Every host, by events hosted')).toBeGreaterThan(0);
    expect(at('<h2>All-time awards</h2>')).toBeGreaterThan(
      at('Every host, by events hosted'),
    );
    expect(at("<h2>Where we've hosted</h2>")).toBeGreaterThan(
      at('<h2>All-time awards</h2>'),
    );
    expect(at('<h2>Archive</h2>')).toBeGreaterThan(
      at("<h2>Where we've hosted</h2>"),
    );
    const boards = res.text.slice(
      at('<h2>All-time awards</h2>'),
      at("<h2>Where we've hosted</h2>"),
    );
    expect(boards.match(/<details class="ui-collapsible"/g)).toHaveLength(9);
    for (const title of [
      'Most attendees hosted',
      'Longest weekly streak',
      'Longest daily streak',
      'Most gold medals',
      'Most medals',
      'Most events in one month',
      'Biggest single event',
      'Widest variety',
      'Most months active',
    ]) {
      expect(boards).toContain(title);
    }
    // Emoji with words; names link to profiles; titles escaped.
    expect(boards).toContain('aria-label="Weekly streak"');
    expect(boards).toContain('aria-label="Daily streak"');
    expect(boards).toContain('href="/host/hosts/1"');
    expect(boards).not.toContain('<script>alert');
  });

  it('attendance boards leave out events without attendance data and say so', async () => {
    const events = [
      { ...ev('2026-10-02', ['1']), attendance: 12 },
      { ...ev('2026-10-03', ['2']), attendance: undefined },
    ];
    const store = fakeStore(events, NAMES);
    const { req, sid } = await app(store);
    const res = await req.get('/host/leaderboard?view=all').set('Cookie', sid);
    expect(res.text).toContain('1 event without attendance data is left out.');
    expect(res.text).toContain('12 attendees');
  });

  it('a mass tie stops at 25 rows: "and N more tied at 1st"', async () => {
    const events = Array.from({ length: 30 }, (_, n) => ({
      ...ev('2026-10-02', [String(1000 + n)]),
      attendance: 5,
    }));
    const store = fakeStore(events, NAMES);
    const { req, sid } = await app(store);
    const res = await req.get('/host/leaderboard?view=all').set('Cookie', sid);
    expect(res.text).toContain('and 5 more tied at 1st');
    expect(res.text).toContain('30 tied at 5 attendees');
  });

  it('the archive lists each closed month’s medalists exactly as its month page does', async () => {
    const store = fakeStore(EVENTS, NAMES);
    // Awarded off an earlier listing: Cy won with 9 (as the month page shows).
    store.months.add('2026-10');
    store.stored.push({ month: '2026-10', memberId: '3', place: 1, events: 9 });
    const { req, sid } = await app(store);
    const all = await req.get('/host/leaderboard?view=all').set('Cookie', sid);
    const archive = all.text.slice(all.text.indexOf('<h2>Archive</h2>'));
    const start = archive.indexOf('href="/host/leaderboard?month=2026-10"');
    const october = archive.slice(start, archive.indexOf('</li>', start));
    expect(october).toContain('href="/host/leaderboard?month=2026-10"');
    expect(october).toContain('Gold medal, October 2026');
    expect(october).toContain('<bdi>Cy</bdi>');
    expect(october).toContain('(9 events)');
    expect(october).not.toContain('Bea');
    const month = await req
      .get('/host/leaderboard?month=2026-10')
      .set('Cookie', sid);
    expect(month.text.match(/Gold medal, October 2026/g)).toHaveLength(2);
    expect(month.text).toContain('<bdi>Cy</bdi>');
  });

  it('the archive says when a closed month is not awarded yet', async () => {
    const store = fakeStore(EVENTS, NAMES);
    const { req, sid } = await app(store, {
      snapshot: async () => ({
        hasFinishedFull: async () => true,
        lastFinishedRun: async () => RUN,
        lastCompleteListing: async () => undefined,
      }),
    });
    const res = await req.get('/host/leaderboard?view=all').set('Cookie', sid);
    const archive = res.text.slice(res.text.indexOf('<h2>Archive</h2>'));
    expect(archive).toContain('October 2026');
    expect(archive).toContain('medals not awarded yet');
  });

  it('before any names are collected, the pages say when they will appear', async () => {
    const store = fakeStore(EVENTS, {});
    const { req, sid } = await app(store);
    for (const path of ['/host/leaderboard', '/host/leaderboard?view=all']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await req.get(path).set('Cookie', sid);
      expect(res.text).toContain(
        'Host names appear after the next daily update from Meetup.',
      );
      expect(res.text).toContain('Unnamed host');
    }
    const named = await app(fakeStore(EVENTS, NAMES));
    const res = await named.req
      .get('/host/leaderboard?view=all')
      .set('Cookie', named.sid);
    expect(res.text).not.toContain('Host names appear after');
  });

  it('the Hall of fame table: the short list, a gap row, the viewer marked, and Show all / back', async () => {
    // 20 hosts with 20 down to 1 events; the viewer (4242) is 12th.
    const many: LeaderboardEvent[] = [];
    for (let h = 0; h < 20; h += 1) {
      const id = h === 11 ? '4242' : String(100 + h);
      for (let n = 0; n < 20 - h; n += 1) {
        many.push(ev(`2026-0${1 + (n % 9)}-1${n % 9}`, [id]));
      }
    }
    const store = fakeStore(many, NAMES);
    const { req, sid } = await app(store);
    const res = await req.get('/host/leaderboard?view=all').set('Cookie', sid);
    const table = res.text.slice(
      res.text.indexOf('Every host, by events hosted'),
      res.text.indexOf('<h2>All-time awards</h2>'),
    );
    expect(rowsOf(table).map((r) => r[0])).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '',
      '9',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
    ]);
    expect(table).toContain('3 hosts not shown (places 6 to 8)');
    expect(table).toMatch(/<tr class="you-row">[\s\S]*?<bdi>Ann<\/bdi>/);
    expect(table).toContain('href="/host/leaderboard?view=all&amp;hosts=all"');
    expect(table).toContain('Show all 20 hosts');
    expect(table).toContain('20 hosts, 210 events.');

    const full = await req
      .get('/host/leaderboard?view=all&hosts=all')
      .set('Cookie', sid);
    const fullTable = full.text.slice(
      full.text.indexOf('Every host, by events hosted'),
      full.text.indexOf('<h2>All-time awards</h2>'),
    );
    expect(rowsOf(fullTable)).toHaveLength(20);
    expect(fullTable).not.toContain('not shown');
    expect(fullTable).toContain('Show the short list');
  });
});

describe('shortList (Hai: first 5, a gap, 3 either side of you; top 10 if you are in it)', () => {
  /** n hosts h0…, distinct counts unless `places` gives the places. */
  const board = (n: number, places?: number[]): Standing[] =>
    Array.from({ length: n }, (_, i) => ({
      memberId: `h${i}`,
      events: n - i,
      place: places?.[i] ?? i + 1,
    }));
  function shape(items: ReturnType<typeof shortList>): string[] {
    return items.map((i) => {
      if (i.kind === 'gap') {
        return `gap ${i.count} (${i.from}-${i.to})`;
      }
      return `${i.standing.place}${i.you ? '*' : ''}`;
    });
  }
  const top10 = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

  it('viewer 1st or 10th: just the top 10', () => {
    expect(shape(shortList(board(50), 'h0'))).toEqual([
      '1*',
      ...top10.slice(1),
    ]);
    expect(shape(shortList(board(50), 'h9'))).toEqual([
      ...top10.slice(0, 9),
      '10*',
    ]);
  });

  it('viewer not on the board: the top 10', () => {
    expect(shape(shortList(board(50), 'staff'))).toEqual(top10);
  });

  it('viewer 11th and 12th: the first 5, a gap, then 3 either side', () => {
    expect(shape(shortList(board(50), 'h10'))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      'gap 2 (6-7)',
      '8',
      '9',
      '10',
      '11*',
      '12',
      '13',
      '14',
    ]);
    expect(shape(shortList(board(50), 'h11'))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      'gap 3 (6-8)',
      '9',
      '10',
      '11',
      '12*',
      '13',
      '14',
      '15',
    ]);
  });

  it('mid-table and last', () => {
    expect(shape(shortList(board(50), 'h29'))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      'gap 21 (6-26)',
      '27',
      '28',
      '29',
      '30*',
      '31',
      '32',
      '33',
    ]);
    expect(shape(shortList(board(50), 'h49'))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      'gap 41 (6-46)',
      '47',
      '48',
      '49',
      '50*',
    ]);
  });

  it('a tie at the 5th/6th boundary: rows go by list order, places stay true', () => {
    const places = [
      1, 2, 3, 4, 5, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ];
    expect(shape(shortList(board(20, places), 'h15'))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      'gap 7 (5-12)',
      '13',
      '14',
      '15',
      '16*',
      '17',
      '18',
      '19',
    ]);
  });

  it('a viewer tied for 10th further down the list still gets the top 10, ties included', () => {
    const places = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 13];
    expect(shape(shortList(board(13, places), 'h11'))).toEqual([
      ...top10,
      '10',
      '10*',
    ]);
  });

  it('the full view shows every row', () => {
    expect(shortList(board(50), 'h29', true)).toHaveLength(50);
  });
});

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
/** An evening event on a Pacific day. */
const ev = (
  day: string,
  hostIds: string[],
  title = 'Games',
): LeaderboardEvent => {
  seq += 1;
  return {
    id: String(seq),
    title,
    dateTime: new Date(`${day}T19:00:00-08:00`),
    status: 'PAST',
    hostIds,
  };
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
  ev('2026-10-02', ['1', '2']),
  ev('2026-10-03', ['1']),
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
    expect(res.text).toContain('<strong><bdi>Ann</bdi></strong>');
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

  it('keeps medals once awarded, whatever later corrections do', async () => {
    const store = fakeStore(EVENTS, NAMES);
    store.months.add('2026-10');
    store.stored.push({ month: '2026-10', memberId: '3', place: 1, events: 9 });
    const { req, sid } = await app(store);
    const res = await req
      .get('/host/leaderboard?month=2026-10')
      .set('Cookie', sid);
    expect(store.mocks.award).not.toHaveBeenCalled();
    expect(res.text.match(/Gold medal, October 2026/g)).toHaveLength(2);
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
});

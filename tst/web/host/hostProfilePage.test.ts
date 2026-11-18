import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostResolution } from '../../../src/lib/hosts/eligibility.js';
import {
  LeaderboardEvent,
  Medal,
} from '../../../src/lib/leaderboard/standings.js';
import { LeaderboardStore } from '../../../src/lib/repositories/postgresLeaderboardRepository.js';
import { SnapshotRun } from '../../../src/lib/repositories/postgresSnapshotRepository.js';
import type { HostedEvent } from '../../../src/lib/wrapped/stats.js';
import { createHostRouter } from '../../../src/web/host/hostRouter.js';
import { HostProfileDeps } from '../../../src/web/host/hostProfilePage.js';
import { registerLeaderboardPage } from '../../../src/web/host/leaderboardPage.js';
import { clientFor, listen } from '../../setup/loopbackServer.js';
import {
  DISCORD_USER,
  closeServers,
  makeHostDeps,
  signInWithMeetup,
} from './hostHarness.js';

afterEach(closeServers);

const NOW = new Date('2026-11-17T18:00:00Z');
const HOSTILE = '<script>alert(1)</script>"><img src=x>';
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

/** One event as both stores see it: the leaderboard's row and the snapshot's hosted event. */
const both = (
  id: string,
  day: string,
  hostIds: string[],
  title: string,
  attendance: number,
) => ({
  board: { id, title, status: 'PAST' as const, hostIds, day },
  hosted: {
    id,
    title,
    dateTime: `${day}T19:00:00-08:00`,
    eventUrl: `https://www.meetup.com/g/events/${id}/`,
    attendance,
  },
});

const EVENTS = [
  both('101', '2026-10-02', ['1', '2'], 'Board game night', 12),
  both('102', '2026-10-03', ['1'], 'Hot pot dinner', 20),
  both('103', '2026-10-04', ['1'], HOSTILE, 7),
  both('104', '2026-10-21', ['1'], 'Hike (cancelled)', 30),
  both('105', '2026-11-16', ['1', '4242'], 'Mission Peak hike', 15),
];

function store(): LeaderboardStore {
  const months = new Set<string>();
  const medals: Medal[] = [];
  return {
    hostedEvents: async (): Promise<LeaderboardEvent[]> =>
      EVENTS.map((e) => e.board),
    hostNames: async () =>
      new Map([
        ['1', 'Bea'],
        ['2', 'Bo'],
        ['4242', 'Ann'],
      ]),
    medals: async () => [...medals],
    awardedMonths: async () => new Set(months),
    award: async (list) => {
      list.forEach((m) => {
        months.add(m.month);
        medals.push(...m.medals);
      });
    },
  };
}

async function app(
  profiles: Partial<HostProfileDeps> = {},
  resolve?: HostResolution,
) {
  const hostedEvents = vi.fn(async (id: string): Promise<HostedEvent[]> =>
    EVENTS.filter((e) => e.board.hostIds.includes(id)).map((e) => e.hosted),
  );
  const isPromoted = vi.fn(async (id: string) => id === '1');
  const deps: HostProfileDeps = { hostedEvents, isPromoted, ...profiles };
  const { deps: routerDeps } = makeHostDeps({
    ...(resolve ? { resolve: vi.fn().mockResolvedValue(resolve) } : {}),
    pages: (router) =>
      registerLeaderboardPage(router, {
        store: async () => store(),
        snapshot: async () => ({
          hasFinishedFull: async () => true,
          lastFinishedRun: async () => RUN,
          lastCompleteListing: async () => RUN.listedAt,
        }),
        now: () => NOW,
        profiles: deps,
      }),
  });
  const server = await listen(
    express().use('/host', createHostRouter(routerDeps)),
  );
  const req = clientFor(server);
  return { req, sid: await signInWithMeetup(req), hostedEvents, isPromoted };
}

describe('host profile', () => {
  it('shows a host’s public hosting record: counted events, attendees, medals, types, top and recent events', async () => {
    const { req, sid, hostedEvents } = await app();
    const res = await req.get('/host/hosts/1').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h1><bdi>Bea</bdi></h1>');
    expect(res.text).toContain('Community Host');
    // Four counted events (the cancelled hike is not), 12 + 20 + 7 + 15.
    expect(res.text).toMatch(/<dt>Events hosted<\/dt>\s*<dd>4<\/dd>/);
    expect(res.text).toMatch(/<dt>Attendees hosted<\/dt>\s*<dd>54<\/dd>/);
    expect(res.text).not.toContain('Hike (cancelled)');
    // October's gold, linked to that month.
    expect(res.text).toContain('Gold medal, October 2026');
    expect(res.text).toContain('href="/host/leaderboard?month=2026-10"');
    expect(res.text).toContain('Games: 1 event');
    expect(res.text).toContain('Outdoors: 1 event');
    // Top events by attendees: the hot pot (20) first.
    const top = res.text.slice(res.text.indexOf('Top events'));
    expect(top.indexOf('Hot pot dinner')).toBeLessThan(
      top.indexOf('Mission Peak hike'),
    );
    // Titles are escaped; streaks have text alternatives.
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).toContain('aria-label="Weekly streak"');
    expect(res.text).toContain('aria-label="Daily streak"');
    // Hosting only: the one read is the host's own hosted events.
    expect(hostedEvents).toHaveBeenCalledWith('1');
  });

  it('marks your own profile and shows Guest Host for a host who is not promoted', async () => {
    const { req, sid } = await app();
    const res = await req.get('/host/hosts/4242').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<span class="badge info">You</span>');
    expect(res.text).toContain('Guest Host');
    expect(res.text).toContain('No medals yet.');
  });

  it('is a 404 for a non-digit id or someone with no counted hosted events', async () => {
    const { req, sid, hostedEvents } = await app();
    for (const path of [
      '/host/hosts/abc',
      '/host/hosts/999',
      '/host/hosts/1x',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await req.get(path).set('Cookie', sid);
      expect(res.status).toBe(404);
      expect(res.text).toContain('No such host');
    }
    expect(hostedEvents).not.toHaveBeenCalled();
  });

  it('a snapshot failure is a 503; a failed promotion check only drops the badge', async () => {
    const one = await app({
      hostedEvents: vi.fn().mockRejectedValue(new Error('db down')),
    });
    const res = await one.req.get('/host/hosts/1').set('Cookie', one.sid);
    expect(res.status).toBe(503);

    const two = await app({
      isPromoted: vi.fn().mockRejectedValue(new Error('db down')),
    });
    const ok = await two.req.get('/host/hosts/1').set('Cookie', two.sid);
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain('Community Host');
    expect(ok.text).not.toContain('Guest Host');
  });

  it('is for hosts only', async () => {
    const { req, sid, hostedEvents } = await app(
      {},
      {
        kind: 'member',
        meetupMemberId: '4242',
        discordUserId: DISCORD_USER.id,
      },
    );
    const res = await req.get('/host/hosts/1').set('Cookie', sid);
    expect(res.status).toBe(403);
    expect(hostedEvents).not.toHaveBeenCalled();
    const anonymous = await req.get('/host/hosts/1');
    expect(anonymous.status).toBe(302);
  });
});

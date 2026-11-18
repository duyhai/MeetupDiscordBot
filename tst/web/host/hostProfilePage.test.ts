import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GUEST_HOST_MEETUP_BLACKLIST } from '../../../src/constants.js';
import { HostResolution } from '../../../src/lib/hosts/eligibility.js';
import { LeaderboardDeps } from '../../../src/lib/leaderboard/leaderboard.js';
import {
  LeaderboardEvent,
  Medal,
} from '../../../src/lib/leaderboard/standings.js';
import { LeaderboardStore } from '../../../src/lib/repositories/postgresLeaderboardRepository.js';
import {
  ProfileEvent,
  SnapshotRun,
} from '../../../src/lib/repositories/postgresSnapshotRepository.js';
import { createHostRouter } from '../../../src/web/host/hostRouter.js';
import {
  HostProfileDeps,
  tierBadge,
} from '../../../src/web/host/hostProfilePage.js';
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

/** One event as both stores see it: the leaderboard's row and the profile's. */
const both = (
  id: string,
  day: string,
  hostIds: string[],
  title: string,
  attendance: number | undefined,
  {
    inProfile = true,
    place = { latE2: 4761, lonE2: -12233, city: 'Seattle' },
  }: { inProfile?: boolean; place?: LeaderboardEvent['place'] } = {},
) => ({
  inProfile,
  board: { id, title, status: 'PAST' as const, hostIds, day, place },
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
  // Ties the hot pot on 20: the more recent comes first in Top events.
  both('105', '2026-11-16', ['1', '4242'], 'Mission Peak hike', 20),
  // Never read from Meetup: no attendance data.
  both('106', '2026-11-10', ['1'], 'Karaoke night', undefined),
  // Counted by the leaderboard, missing from the attendance read.
  both('107', '2026-11-12', ['1'], 'Boba walk', 99, { inProfile: false }),
  // Hosted by an id on the Guest Host blacklist.
  both(
    '108',
    '2026-11-13',
    [GUEST_HOST_MEETUP_BLACKLIST[0]],
    'Trivia night',
    9,
  ),
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
        ['2', HOSTILE],
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
  {
    resolve,
    snapshot,
  }: {
    resolve?: HostResolution;
    snapshot?: LeaderboardDeps['snapshot'];
  } = {},
) {
  const hostedEvents = vi.fn(async (id: string): Promise<ProfileEvent[]> =>
    EVENTS.filter((e) => e.inProfile && e.board.hostIds.includes(id)).map(
      (e) => e.hosted,
    ),
  );
  const isPromoted = vi.fn(async (id: string) => id === '1');
  const deps: HostProfileDeps = { hostedEvents, isPromoted, ...profiles };
  const { deps: routerDeps } = makeHostDeps({
    ...(resolve ? { resolve: vi.fn().mockResolvedValue(resolve) } : {}),
    pages: (router) =>
      registerLeaderboardPage(router, {
        store: async () => store(),
        snapshot:
          snapshot ??
          (async () => ({
            hasFinishedFull: async () => true,
            lastFinishedRun: async () => RUN,
            lastCompleteListing: async () => RUN.listedAt,
          })),
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

const section = (text: string, heading: string) =>
  text.slice(text.indexOf(`<h2>${heading}</h2>`));

describe('host profile', () => {
  it('shows a host’s public hosting record: counted events, attendees, medals, types, top and recent events', async () => {
    const { req, sid, hostedEvents } = await app();
    const res = await req.get('/host/hosts/1').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h1><bdi>Bea</bdi></h1>');
    expect(res.text).toContain('Community Host');
    // Six counted events, as the leaderboard counts them (the cancelled hike
    // is not; the boba walk counts though the attendance read lacks it).
    expect(res.text).toMatch(/<dt>Events hosted<\/dt>\s*<dd>6<\/dd>/);
    // Known attendance only: 12 + 20 + 7 + 20.
    expect(res.text).toMatch(/<dt>Attendees hosted<\/dt>\s*<dd>59<\/dd>/);
    expect(res.text).not.toContain('Hike (cancelled)');
    // October's gold, linked to that month.
    expect(res.text).toContain('Gold medal, October 2026');
    expect(res.text).toContain('href="/host/leaderboard?month=2026-10"');
    expect(res.text).toContain('Games: 1 event');
    expect(res.text).toContain('Outdoors: 1 event');
    // Titles are escaped; streaks have text alternatives.
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).toContain('aria-label="Weekly streak"');
    expect(res.text).toContain('aria-label="Daily streak"');
    // Hosting only: the one read is the host's own hosted events.
    expect(hostedEvents).toHaveBeenCalledWith('1');
  });

  it('Top events: ties go to the more recent; events without attendance data are left out', async () => {
    const { req, sid } = await app();
    const res = await req.get('/host/hosts/1').set('Cookie', sid);
    const top = section(res.text, 'Top events');
    const recent = section(res.text, 'Recent events');
    const topOnly = top.slice(0, top.indexOf('<h2>Recent events</h2>'));
    expect(topOnly.indexOf('Mission Peak hike')).toBeLessThan(
      topOnly.indexOf('Hot pot dinner'),
    );
    expect(topOnly).not.toContain('Karaoke night');
    // Listed among recent events, with a dash for its attendance.
    expect(recent).toMatch(
      /Karaoke night[\s\S]*?<td data-label="Attendees">\s*<span title="No attendance data">–<\/span>/,
    );
  });

  it('escapes a hostile host name in the heading and the page title', async () => {
    const { req, sid } = await app();
    const res = await req.get('/host/hosts/2').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).not.toContain('<img src=x>');
    expect(res.text).toContain('<title>&lt;script&gt;');
  });

  it('marks your own profile, and shows no tier badge for a host who is not promoted', async () => {
    const { req, sid } = await app();
    const res = await req.get('/host/hosts/4242').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<span class="badge info">You</span>');
    expect(res.text).not.toContain('Community Host');
    expect(res.text).not.toContain('Guest Host');
    expect(res.text).toContain('No medals yet.');
  });

  it('never shows a tier badge for an id on the Guest Host blacklist', () => {
    expect(GUEST_HOST_MEETUP_BLACKLIST.length).toBeGreaterThan(0);
    expect(tierBadge(GUEST_HOST_MEETUP_BLACKLIST[0], true)).toBe('');
    expect(tierBadge('1', true)).not.toBe('');
    expect(tierBadge('1', false)).toBe('');
    expect(tierBadge('1', undefined)).toBe('');
  });

  it('404: a non-digit id reads nothing; an unknown, leading-zero or non-host id never reads attendance', async () => {
    const { req, sid, hostedEvents } = await app();
    for (const path of [
      '/host/hosts/abc',
      '/host/hosts/1x',
      '/host/hosts/999',
      '/host/hosts/007',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await req.get(path).set('Cookie', sid);
      expect(res.status).toBe(404);
      expect(res.text).toContain('No such host');
    }
    expect(hostedEvents).not.toHaveBeenCalled();
  });

  it('a failed attendance read is a 503 for a host and still a 404 for a non-host', async () => {
    const { req, sid } = await app({
      hostedEvents: vi.fn().mockRejectedValue(new Error('db down')),
    });
    expect((await req.get('/host/hosts/1').set('Cookie', sid)).status).toBe(
      503,
    );
    expect((await req.get('/host/hosts/999').set('Cookie', sid)).status).toBe(
      404,
    );
  });

  it('a failed promotion check only drops the badge', async () => {
    const { req, sid } = await app({
      isPromoted: vi.fn().mockRejectedValue(new Error('db down')),
    });
    const ok = await req.get('/host/hosts/1').set('Cookie', sid);
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain('Community Host');
  });

  it('says profiles are being built before the first full pull', async () => {
    const { req, sid, hostedEvents } = await app(
      {},
      {
        snapshot: async () => ({
          hasFinishedFull: async () => false,
          lastFinishedRun: async () => undefined,
          lastCompleteListing: async () => undefined,
        }),
      },
    );
    const res = await req.get('/host/hosts/1').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('still being built');
    expect(hostedEvents).not.toHaveBeenCalled();
  });

  it('is for hosts only', async () => {
    const { req, sid, hostedEvents } = await app(
      {},
      {
        resolve: {
          kind: 'member',
          meetupMemberId: '4242',
          discordUserId: DISCORD_USER.id,
        },
      },
    );
    const res = await req.get('/host/hosts/1').set('Cookie', sid);
    expect(res.status).toBe(403);
    expect(hostedEvents).not.toHaveBeenCalled();
    const anonymous = await req.get('/host/hosts/1');
    expect(anonymous.status).toBe(302);
  });

  it('says how many events Attendees hosted leaves out, counting the ones missing from the attendance read', async () => {
    const { req, sid } = await app();
    const res = await req.get('/host/hosts/1').set('Cookie', sid);
    // 106 (unknown attendance) and 107 (missing from the read).
    expect(res.text).toContain(
      'Attendees hosted excludes 2 events without attendance data.',
    );
    const own = await req.get('/host/hosts/4242').set('Cookie', sid);
    expect(own.text).not.toContain('without attendance data.');
  });

  it('a profile has a map of where they hosted, with OSM tiles allowed', async () => {
    const { req, sid } = await app();
    const res = await req.get('/host/hosts/1').set('Cookie', sid);
    expect(res.text).toContain("Where they've hosted");
    expect(res.text).toContain('data-map-cells="[[47.61,-122.33,6]]"');
    expect(res.text).toContain('Where Bea has hosted');
    expect(String(res.headers['content-security-policy'])).toContain(
      'https://tile.openstreetmap.org',
    );
  });

  it('no profile map for an id on the Guest Host blacklist, and no tile CSP', async () => {
    const { req, sid } = await app();
    const res = await req
      .get(`/host/hosts/${GUEST_HOST_MEETUP_BLACKLIST[0]}`)
      .set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('data-map-cells');
    expect(res.text).not.toContain('leaflet.js');
    expect(String(res.headers['content-security-policy'])).not.toContain(
      'tile.openstreetmap.org',
    );
  });
});

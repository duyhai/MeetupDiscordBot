import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostEvent } from '../../../src/lib/hosts/hostEvents.js';
import { createHostRouter } from '../../../src/web/host/hostRouter.js';
import { registerHostPages } from '../../../src/web/host/hostPages.js';
import { clientFor, listen } from '../../setup/loopbackServer.js';
import {
  HOST,
  closeServers,
  makeHostDeps,
  signInWithDiscord,
  signInWithMeetup,
} from './hostHarness.js';

afterEach(closeServers);

// Tuesday 2026-11-03, 10:00 Pacific.
const NOW = new Date('2026-11-03T18:00:00Z');
const HOSTILE = '<script>alert(1)</script>"><img src=x>‮evil';

const ev = (
  id: string,
  dateTime: string,
  title: string,
  type: HostEvent['type'] = 'social',
): HostEvent => ({
  id,
  title,
  dateTime,
  eventUrl: `https://www.meetup.com/g/events/${id}/`,
  type,
  hosts: [{ id: '4242', name: HOSTILE }],
});

async function pagesApp(
  fetchGroupEvents: (filter: {
    status?: string[];
    hostId?: string;
  }) => Promise<HostEvent[]>,
  overrides: Parameters<typeof makeHostDeps>[0] = {},
) {
  const { deps } = makeHostDeps({
    ...overrides,
    pages: (router) =>
      registerHostPages(router, {
        events: { fetchGroupEvents: vi.fn(fetchGroupEvents), now: () => NOW },
      }),
  });
  const app = express();
  app.use('/host', createHostRouter(deps));
  const server = await listen(app);
  return clientFor(server);
}

const noScript = (text: string) => {
  expect(text).not.toContain('<script>alert');
  expect(text).not.toContain('<img src=x>');
  expect(text).toContain('&lt;script&gt;');
};

describe('host home', () => {
  it('lists the host’s upcoming events and quiet days, escaped', async () => {
    const req = await pagesApp(async (filter) => {
      if (filter.hostId) {
        return [ev('1', '2026-11-10T19:00:00-08:00', HOSTILE)];
      }
      return [ev('2', '2026-11-04T19:00:00-08:00', 'Group dinner')];
    });
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host').set('Cookie', sid);
    expect(res.status).toBe(200);
    noScript(res.text);
    expect(res.text).toContain('<bdi>');
    expect(res.text).toContain('Guest Host');
    expect(res.text).toContain('Quiet days in the next two weeks');
    // Nov 4 has an event, so the first quiet day after today is Nov 5.
    expect(res.text).not.toContain('Wed, Nov 4</li>');
    expect(res.text).toContain('Thu, Nov 5');
    expect(res.text).toContain('aria-current="page">Home');
  });

  it('nudges an unlinked Meetup sign-in to link Discord, and shows Community Host', async () => {
    const req = await pagesApp(async () => [], {
      resolve: vi.fn().mockResolvedValue({
        ...HOST,
        discordUserId: undefined,
        tier: 'promoted',
      }),
    });
    const sid = await signInWithMeetup(req);
    const res = await req.get('/host').set('Cookie', sid);
    expect(res.text).toContain('not linked to Discord');
    expect(res.text).toContain('Community Host');
    expect(res.text).toContain('You have no upcoming events');
  });

  it('a Meetup outage is a 503 page, never a partial one', async () => {
    const req = await pagesApp(async () => {
      throw new Error('organizer token unavailable');
    });
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host').set('Cookie', sid);
    expect(res.status).toBe(503);
    expect(res.text).toContain('cannot be loaded from Meetup');
    expect(res.text).not.toContain('Your upcoming events');
  });
});

describe('host calendar', () => {
  it('shows 8 weeks with busy levels, holidays from titles, and the day list', async () => {
    const req = await pagesApp(async () => [
      ev('a', '2026-11-05T19:00:00-08:00', HOSTILE),
      ev('b', '2026-11-07T19:00:00-08:00', 'One'),
      ev('c', '2026-11-07T20:00:00-08:00', 'Two'),
      ev('d', '2026-11-07T21:00:00-08:00', 'Three'),
      ev('e', '2026-11-28T18:00:00-08:00', 'Friendsgiving potluck'),
    ]);
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host/calendar').set('Cookie', sid);
    expect(res.status).toBe(200);
    noScript(res.text);
    expect(res.text.match(/<td class="cal /g)).toHaveLength(56);
    // Monday Nov 2 is before today: muted, not shaded.
    expect(res.text).toMatch(
      /<td class="cal past">\s*<span class="cal-day"\s*>2</,
    );
    expect(res.text).toMatch(
      new RegExp(
        '<td class="cal busy3">\\s*<a class="cal-day" href="/host/create\\?day=2026-11-07"\\s*>' +
          '<span class="sr-only">Host an event on </span>7<',
      ),
    );
    // Named from the title on Nov 28, never marked on Thanksgiving (Nov 26).
    expect(res.text).toMatch(
      /<td class="cal busy1">\s*<a class="cal-day"[^>]*>(?:(?!<\/td>)[^])*>28<\/a\s*>(?:(?!<\/td>)[^])*Thanksgiving/,
    );
    expect(res.text).not.toMatch(
      /<\/span>26<\/a\s*>(?:(?!<\/td>)[^])*Thanksgiving/,
    );
    expect(res.text).toContain('<span class="badge info">Thanksgiving</span>');
    expect(res.text).toContain('3 events');
    // A past day shows no count: only upcoming events are read.
    expect(res.text).not.toMatch(/<td class="cal past">(?:(?!<\/td>)[^])*Free/);
    expect(res.text).not.toContain('style=');
  });
});

describe('host history', () => {
  const past = [
    ev('1', '2026-10-01T19:00:00-07:00', 'Board game night', 'games'),
    ev('2', '2026-09-01T19:00:00-07:00', HOSTILE, 'food'),
    ev('3', '2025-01-01T19:00:00-08:00', 'Old hike', 'outdoors'),
  ];

  it('heat map, type counts, and attendance links for the host’s past events', async () => {
    const fetch = vi.fn(async () => past);
    const req = await pagesApp(fetch);
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host/history').set('Cookie', sid);
    expect(res.status).toBe(200);
    noScript(res.text);
    expect(res.text).toContain('3 hosted events in all.');
    expect(res.text).toContain('Games (1)');
    expect(res.text).toContain(
      'href="https://www.meetup.com/g/events/1/attendees/"',
    );
    // The 2025 event is outside the 12-month map.
    expect(res.text).toContain('2 events in the past year shown.');
  });

  it('filters by type, and ignores an unknown one', async () => {
    const req = await pagesApp(async () => past);
    const sid = await signInWithDiscord(req);
    const games = await req.get('/host/history?type=games').set('Cookie', sid);
    expect(games.text).toContain('Board game night');
    expect(games.text).not.toContain('Old hike');
    const unknown = await req
      .get('/host/history?type=__proto__')
      .set('Cookie', sid);
    expect(unknown.status).toBe(200);
    expect(unknown.text).toContain('Old hike');
  });

  it('an empty history says so', async () => {
    const req = await pagesApp(async () => []);
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host/history').set('Cookie', sid);
    expect(res.text).toContain('No past events yet.');
  });

  it('reads only the signed-in host’s events', async () => {
    const fetch = vi.fn(async () => past);
    const req = await pagesApp(fetch);
    const sid = await signInWithDiscord(req);
    await req.get('/host/history?hostId=999').set('Cookie', sid);
    expect(fetch).toHaveBeenCalledWith({ status: ['PAST'], hostId: '4242' });
  });
});

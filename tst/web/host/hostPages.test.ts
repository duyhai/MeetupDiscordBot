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
    // The cell of a day, up to its closing </td>.
    const cell = (day: string) =>
      new RegExp(
        `<span class="cal-day"\\s*>${day}</span\\s*>(?:(?!</td>)[^])*</td>`,
      ).exec(res.text)?.[0] ?? '';
    // Day numbers are plain text; from tomorrow a + link opens the form.
    expect(res.text).not.toContain('<a class="cal-day"');
    expect(cell('7')).toMatch(
      /<a\s+class="cal-add"\s+href="\/host\/create\?day=2026-11-07"\s+aria-label="Host an event on Sat, Nov 7"\s*>\+<\/a/,
    );
    expect(res.text).toMatch(
      /<td class="cal busy3">\s*<div class="cal-head">\s*<span class="cal-day"\s*>7</,
    );
    // Today: events, but no + (requests start tomorrow).
    expect(cell('3')).not.toContain('cal-add');
    expect(cell('3')).toContain('<details class="cal-pop">');
    expect(cell('3')).not.toContain('Host on this day');
    // Named from the title on Nov 28, never marked on Thanksgiving (Nov 26).
    expect(cell('28')).toContain('Thanksgiving');
    expect(cell('26')).not.toContain('Thanksgiving');
    expect(res.text).toContain('<span class="badge info">Thanksgiving</span>');
    expect(res.text).toContain('3 events');
    // A past day shows no count: only upcoming events are read.
    expect(res.text).not.toMatch(/<td class="cal past">(?:(?!<\/td>)[^])*Free/);
    expect(res.text).not.toContain('style=');
  });
});

describe('host calendar popovers', () => {
  it('each day’s popover lists every event, escaped, and offers Host on this day', async () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      ev(`m${i}`, `2026-11-12T${String(10 + i)}:00:00-08:00`, `Event ${i}`),
    );
    const req = await pagesApp(async () => [
      ...many,
      ev('h', '2026-11-13T19:00:00-08:00', HOSTILE),
    ]);
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host/calendar').set('Cookie', sid);
    noScript(res.text);
    const panel = (label: string) =>
      new RegExp(
        `<div class="cal-panel" role="group" aria-label="${label}">(?:(?!</details>)[^])*`,
      ).exec(res.text)?.[0] ?? '';
    const thu = panel('Thu, Nov 12');
    for (let i = 0; i < 6; i += 1) {
      expect(thu).toContain(`Event ${i}`);
    }
    expect(thu).toContain(
      '<a href="/host/create?day=2026-11-12">Host on this day</a>',
    );
    expect(res.text).toMatch(
      /<summary>\s*<span class="sr-only">Thu, Nov 12: <\/span\s*><span class="cal-count">6 events<\/span>/,
    );
    // A free day still opens, says so, and offers the form.
    const free = panel('Sat, Nov 14');
    expect(free).toContain('No events yet.');
    expect(free).toContain('Host on this day');
    // The enhancement script runs under the page's nonce.
    expect(res.text).toMatch(
      /<script nonce="[A-Za-z0-9+/=]+">\(function\(\)\{var grid=/,
    );
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
    // This year by default: the 2025 event is on the 2025 page.
    expect(res.text).toContain('2 events in 2026.');
    expect(res.text).toMatch(/<strong>2026<\/strong>/);
    // Every row can be copied.
    expect(res.text.match(/>Copy this event<\/a/g)).toHaveLength(3);
  });

  it('pages the map by year: earlier years link back, never past the first hosted year', async () => {
    const req = await pagesApp(async () => past);
    const sid = await signInWithDiscord(req);
    const now = await req.get('/host/history').set('Cookie', sid);
    // Next is disabled this year; Prev links to 2025.
    expect(now.text).toMatch(
      /<a\s+class="button ghost"\s+href="\/host\/history\?year=2025"\s*>← 2025<\/a/,
    );
    expect(now.text).toMatch(
      /<span class="button ghost disabled"\s*>2027 →<span class="sr-only">/,
    );
    const y2025 = await req.get('/host/history?year=2025').set('Cookie', sid);
    expect(y2025.text).toContain('1 event in 2025.');
    expect(y2025.text).toMatch(
      /<span class="button ghost disabled"\s*>← 2024<span class="sr-only">/,
    );
    expect(y2025.text).toMatch(/href="\/host\/history\?year=2026"\s*>2026 →/);
    // Out of range or not a year: this year.
    const odd = await Promise.all(
      ['2019', '2031', 'abc', '2026x'].map((q) =>
        req.get(`/host/history?year=${q}`).set('Cookie', sid),
      ),
    );
    for (const res of odd) {
      expect(res.status).toBe(200);
      expect(res.text).toContain('2 events in 2026.');
    }
    // The type filter keeps the year; the year links keep the type.
    expect(y2025.text).toContain(
      'href="/host/history?type=games&amp;year=2025"',
    );
    const games = await req
      .get('/host/history?type=outdoors&year=2026')
      .set('Cookie', sid);
    expect(games.text).toContain(
      'href="/host/history?type=outdoors&amp;year=2025"',
    );
  });

  it('a heat-map day filters the list to that day, with Clear and Copy this event', async () => {
    const req = await pagesApp(async () => [
      ...past,
      ev('4', '2026-10-01T10:00:00-07:00', 'Morning walk', 'outdoors'),
    ]);
    const sid = await signInWithDiscord(req);
    const all = await req.get('/host/history').set('Cookie', sid);
    // The day's dot links to the filter and carries both events.
    expect(all.text).toContain(
      'href="/host/history?year=2026&amp;day=2026-10-01"',
    );
    expect(all.text).toMatch(
      /aria-label="Thu, Oct 1, 2026: 10:00 AM · Morning walk; 7:00 PM · Board game night"/,
    );
    const day = await req
      .get('/host/history?year=2026&day=2026-10-01')
      .set('Cookie', sid);
    expect(day.text).toContain('Showing Thu, Oct 1, 2026');
    expect(day.text).toMatch(
      /<a href="\/host\/history\?year=2026"\s*>Clear<\/a/,
    );
    expect(day.text).toContain('Morning walk');
    expect(day.text).toContain('Board game night');
    expect(day.text).not.toContain('Old hike');
    expect(day.text.match(/>Copy this event<\/a/g)).toHaveLength(2);
    // With a type: Clear keeps it.
    const typed = await req
      .get('/host/history?type=outdoors&year=2026&day=2026-10-01')
      .set('Cookie', sid);
    expect(typed.text).toContain('Morning walk');
    expect(typed.text).not.toContain('>Board game night<');
    expect(typed.text).toMatch(
      /href="\/host\/history\?type=outdoors&amp;year=2026"\s*>Clear/,
    );
    // A day alone picks its year; a bad day is ignored.
    const alone = await req
      .get('/host/history?day=2025-01-01')
      .set('Cookie', sid);
    expect(alone.text).toContain('1 event in 2025.');
    expect(alone.text).toContain('Showing Wed, Jan 1, 2025');
    // A day decides the year the map shows, whatever ?year says.
    const mixed = await req
      .get('/host/history?year=2026&day=2025-01-01')
      .set('Cookie', sid);
    expect(mixed.text).toContain('1 event in 2025.');
    // A day with no events says so.
    const empty = await req
      .get('/host/history?day=2026-10-02')
      .set('Cookie', sid);
    expect(empty.text).toContain('No events on Fri, Oct 2.');
    const bad = await req
      .get('/host/history?day=2026-02-30')
      .set('Cookie', sid);
    expect(bad.text).not.toContain('Showing');
    expect(bad.text).toContain('Old hike');
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

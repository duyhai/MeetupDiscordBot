import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostEvent } from '../../../src/lib/hosts/hostEvents.js';
import { createHostRouter } from '../../../src/web/host/hostRouter.js';
import {
  beforeParam,
  registerHostPages,
  timelineChunk,
} from '../../../src/web/host/hostPages.js';
import { clientFor, listen } from '../../setup/loopbackServer.js';
import { HostResolution } from '../../../src/lib/hosts/eligibility.js';
import {
  DISCORD_USER,
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
  counted: true,
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
        return [
          ev('1', '2026-11-10T19:00:00-08:00', HOSTILE),
          {
            ...ev('3', '2026-11-12T19:00:00-08:00', '[Open House] Pickleball'),
            counted: false,
          },
        ];
      }
      return [ev('2', '2026-11-04T19:00:00-08:00', 'Group dinner')];
    });
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host').set('Cookie', sid);
    expect(res.status).toBe(200);
    noScript(res.text);
    // An upcoming Open House says once, by its title, that it will not count.
    expect(res.text.match(/Not counted: Open House/g)).toHaveLength(1);
    expect(res.text).toContain('<bdi>');
    expect(res.text).toContain('Guest Host');
    expect(res.text).toContain('Quiet days in the next two weeks');
    // Nov 4 has an event, so the first quiet day after today is Nov 5.
    expect(res.text).not.toContain('Wed, Nov 4</li>');
    expect(res.text).toContain('Thu, Nov 5');
    expect(res.text).toContain('aria-current="page">Home');
    // Type, and each half of Date, keep to one line on desktop; Event is the
    // column that wraps.
    expect(res.text).toContain('<table class="stack upcoming">');
    expect(res.text).toContain('<td class="type" data-label="Type">');
    expect(res.text).toContain('<td class="event" data-label="Event">');
    expect(res.text).toContain('<td class="status" data-label="Status">');
    expect(res.text).toContain('<td class="buttons" data-label="Actions">');
    expect(res.text).toMatch(
      /<span class="when">Tue, Nov 10, 2026,<\/span>\s*<span class="when">7:00 PM<\/span>/,
    );
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

  it('offers a host their Wrapped', async () => {
    const req = await pagesApp(async () => []);
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host').set('Cookie', sid);
    expect(res.text).toContain('href="/host/wrapped"');
    expect(res.text).toContain('Your Wrapped');
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

describe('member home', () => {
  const MEMBER: HostResolution = {
    kind: 'member',
    meetupMemberId: '4242',
    discordUserId: DISCORD_USER.id,
  };

  it('shows a linked member the Wrapped card and their link status, reading no events', async () => {
    const fetchGroupEvents = vi.fn(async () => []);
    const req = await pagesApp(fetchGroupEvents, {
      resolve: vi.fn().mockResolvedValue(MEMBER),
    });
    const sid = await signInWithMeetup(req);
    const res = await req.get('/host').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Hi, <bdi>Ann</bdi>');
    expect(res.text).toContain('href="/host/wrapped"');
    expect(res.text).toContain('Your Wrapped');
    expect(res.text).toContain('linked to Discord');
    // A Meetup sign-in may refresh roles and badges, as a host may.
    expect(res.text).toContain('Refresh roles and badges');
    expect(res.text).not.toContain('Your upcoming events');
    expect(res.text).not.toContain('Host an event');
    expect(res.text).not.toContain('Picking a day');
    expect(res.text).not.toContain('Guest Host');
    expect(fetchGroupEvents).not.toHaveBeenCalled();
  });

  it('a Discord sign-in gets no Verify form', async () => {
    const req = await pagesApp(async () => [], {
      resolve: vi.fn().mockResolvedValue(MEMBER),
    });
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host').set('Cookie', sid);
    expect(res.text).toContain('Your Wrapped');
    expect(res.text).not.toContain('Refresh roles and badges');
  });
});

describe('host calendar', () => {
  it('shows this month with busy levels, holidays from titles, and the day list', async () => {
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
    // November 2026 as whole weeks: Mon Oct 26 to Sun Dec 6, the days
    // around the month left blank.
    expect(res.text.match(/<td class="cal /g)).toHaveLength(42);
    expect(
      res.text.match(/<td class="cal out" aria-hidden="true"><\/td>/g),
    ).toHaveLength(12);
    expect(res.text).toContain('<strong>November 2026</strong>');
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
    // A past day is never "Free": it is not a day to pick any more.
    expect(res.text).not.toMatch(/<td class="cal past">(?:(?!<\/td>)[^])*Free/);
    expect(res.text).not.toContain('style=');
  });
});

describe('host calendar past days', () => {
  it('greys out this month’s past days with what happened, and offers nothing to host on them', async () => {
    const fetch = vi.fn(async (filter: { status?: string[] }) => {
      return filter.status?.[0] === 'PAST'
        ? [
            ev('p1', '2026-11-02T19:00:00-08:00', 'Monday mahjong'),
            // Ended earlier today: in both lists, shown once.
            ev('t1', '2026-11-03T09:00:00-08:00', 'Breakfast club'),
          ]
        : [
            ev('t1', '2026-11-03T09:00:00-08:00', 'Breakfast club'),
            ev('f1', '2026-11-07T19:00:00-08:00', 'Future fondue'),
          ];
    });
    const req = await pagesApp(fetch);
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host/calendar').set('Cookie', sid);
    expect(res.status).toBe(200);
    // Both lists, for the same window (Mon Oct 26 to Mon Dec 7, Pacific).
    const window = {
      afterDateTime: '2026-10-26T07:00:00.000Z',
      beforeDateTime: '2026-12-07T08:00:00.000Z',
    };
    expect(fetch).toHaveBeenCalledWith({ status: ['ACTIVE'], ...window });
    expect(fetch).toHaveBeenCalledWith({ status: ['PAST'], ...window });
    const past =
      /<td class="cal past">\s*<div class="cal-head">\s*<span class="cal-day"\s*>2<(?:(?!<\/td>)[^])*<\/td>/.exec(
        res.text,
      )?.[0];
    expect(past).toBeDefined();
    expect(past).toContain('<span class="cal-count">1 event</span>');
    expect(past).toContain('Monday mahjong');
    expect(past).not.toContain('cal-add');
    expect(past).not.toContain('Host on this day');
    expect(res.text.match(/Breakfast club/g)).toHaveLength(2);
    // The day list has it too, marked past and greyed.
    expect(res.text).toMatch(
      /<li class="past">\s*<h3>\s*Mon, Nov 2 <span class="badge neutral">Past<\/span>/,
    );
    expect(res.text).toContain('<span class="swatch past"></span> Past');
  });

  it('a future month reads no past events', async () => {
    const fetch = vi.fn(async () => []);
    const req = await pagesApp(fetch);
    const sid = await signInWithDiscord(req);
    await req.get('/host/calendar?month=2026-12').set('Cookie', sid);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual([
      expect.objectContaining({ status: ['ACTIVE'] }),
    ]);
  });
});

describe('host calendar months', () => {
  it('pages by month from this one to a year ahead, reading only that month', async () => {
    const fetch = vi.fn(async () => [
      ev('d', '2026-12-10T19:00:00-08:00', 'December dinner'),
    ]);
    const req = await pagesApp(fetch);
    const sid = await signInWithDiscord(req);
    const now = await req.get('/host/calendar').set('Cookie', sid);
    // This month: Prev disabled, Next links to December.
    expect(now.text).toMatch(
      /<span class="button ghost disabled"\s*>← Oct<span class="sr-only">/,
    );
    expect(now.text).toMatch(
      /<a class="button ghost" href="\/host\/calendar\?month=2026-12"\s*>Dec →<\/a/,
    );
    const dec = await req
      .get('/host/calendar?month=2026-12')
      .set('Cookie', sid);
    expect(dec.text).toContain('<strong>December 2026</strong>');
    expect(dec.text).toContain('Day by day: December');
    expect(dec.text).toContain('December dinner');
    expect(dec.text).toMatch(/href="\/host\/calendar\?month=2026-11"\s*>← Nov/);
    // Meetup was asked for Mon Nov 30 to Mon Jan 4 (Pacific midnights).
    expect(fetch).toHaveBeenLastCalledWith({
      status: ['ACTIVE'],
      afterDateTime: '2026-11-30T08:00:00.000Z',
      beforeDateTime: '2027-01-04T08:00:00.000Z',
    });
    // A year ahead is the last month; past, too far or malformed: this month.
    const last = await req
      .get('/host/calendar?month=2027-11')
      .set('Cookie', sid);
    expect(last.text).toContain('<strong>November 2027</strong>');
    // The form takes a year ahead (to Nov 3, 2027): no + or Host link after.
    expect(last.text).toContain('aria-label="Host an event on Wed, Nov 3"');
    expect(last.text).not.toContain('aria-label="Host an event on Thu, Nov 4"');
    expect(last.text).not.toContain('day=2027-11-04');
    expect(last.text).toMatch(/<span class="button ghost disabled"\s*>Dec →/);
    const odd = await Promise.all(
      ['2026-10', '2027-12', '2026-13', 'x'].map((m) =>
        req.get(`/host/calendar?month=${m}`).set('Cookie', sid),
      ),
    );
    for (const res of odd) {
      expect(res.status).toBe(200);
      expect(res.text).toContain('<strong>November 2026</strong>');
    }
  });
});

describe('host theme toggle', () => {
  it('runs the theme script in the head and ships a hidden Auto/Light/Dark toggle', async () => {
    const req = await pagesApp(async () => []);
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host').set('Cookie', sid);
    const head = res.text.slice(0, res.text.indexOf('</head>'));
    expect(head).toMatch(
      /<script nonce="[A-Za-z0-9+/=]+">\(function\(\)\{var KEY='dashboard-theme'/,
    );
    expect(res.text).toMatch(
      /<div\s+class="theme-toggle"\s+role="group"\s+aria-label="Colour theme"\s+data-theme-toggle\s+hidden\s*>/,
    );
    for (const choice of ['auto', 'light', 'dark']) {
      expect(res.text).toContain(`data-choice="${choice}"`);
    }
    // The sign-in page has it too.
    const login = await req.get('/host/login');
    expect(login.text).toContain('data-theme-toggle');
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
    // Every row can be copied, opened on Meetup and taken attendance for,
    // on one line: two named icons and one worded button.
    expect(res.text.match(/aria-label="Copy this event"/g)).toHaveLength(3);
    expect(res.text.match(/aria-label="View on Meetup"/g)).toHaveLength(3);
    expect(res.text).toMatch(
      /<span>Take attendance<\/span\s*><span class="sr-only"> on Meetup<\/span><\/a/,
    );
    expect(res.text).not.toContain('>Copy this event<');
    expect(res.text).toContain('<div class="actions row one-line">');
    expect(res.text).toContain('<td class="type" data-label="Type">');
    expect(res.text).toContain('<td class="event" data-label="Event">');
    // Under its year and month headings, a row's date is the day alone.
    expect(res.text).toContain('<span class="when">Thu, Oct 1</span>');
    expect(res.text).toMatch(/<h3 class="tl-year-head">2026<\/h3>/);
    expect(res.text).toMatch(/<h3 class="tl-year-head">2025<\/h3>/);
    expect(res.text).toMatch(
      /October\s*<span class="tl-count"\s*>1 event<\/span/,
    );
  });

  it('counts only what counts, and shows the excluded on request', async () => {
    const withExcluded = [
      ...past,
      {
        ...ev('4', '2026-08-01T19:00:00-07:00', '[Open House] Pickleball'),
        counted: false,
      },
      {
        ...ev('5', '2026-07-01T19:00:00-07:00', 'Cancelled: Boba'),
        counted: false,
      },
    ];
    const req = await pagesApp(async () => withExcluded);
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host/history').set('Cookie', sid);
    expect(res.text).toContain('3 hosted events in all.');
    expect(res.text).toContain('2 more');
    expect(res.text).toMatch(
      /href="\/host\/history\?year=2026&amp;all=1"\s*>Show excluded/,
    );
    expect(res.text).not.toContain('Pickleball');
    expect(res.text).toContain('2 events in 2026.');

    const all = await req.get('/host/history?all=1').set('Cookie', sid);
    expect(all.text).toContain('3 hosted events in all.');
    expect(all.text).toContain('Pickleball');
    expect(all.text).toContain('Not counted: Open House');
    expect(all.text).toContain('Not counted: cancelled');
    expect(all.text).toMatch(
      /href="\/host\/history\?year=2026"\s*>Hide excluded/,
    );
    // The map and the filters keep the toggle.
    expect(all.text).toContain('4 events in 2026.');
    expect(all.text).toContain(
      'href="/host/history?type=games&amp;year=2026&amp;all=1"',
    );
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
    expect(day.text.match(/aria-label="Copy this event"/g)).toHaveLength(2);
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

describe('host history timeline', () => {
  /** n events a month, every month of each year, newest first. */
  const years = (counts: Record<number, number>): HostEvent[] =>
    Object.entries(counts)
      .flatMap(([y, n]) =>
        Array.from({ length: n }, (_, i) => {
          const month = String(12 - (i % 12)).padStart(2, '0');
          const day = String(1 + Math.floor(i / 12)).padStart(2, '0');
          return ev(
            `${y}${i}`,
            `${y}-${month}-${day}T19:00:00-07:00`,
            `E${y}-${i}`,
          );
        }),
      )
      .sort((a, b) => b.dateTime.localeCompare(a.dateTime));

  it('renders the newest years first, a year rail, and an Older link for the rest', async () => {
    // 2026 alone has 12 (< 30), so 2025 joins it; 2024 and 2023 are older.
    const req = await pagesApp(async () =>
      years({ 2026: 12, 2025: 24, 2024: 5, 2023: 5 }),
    );
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host/history').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-year="2026"');
    expect(res.text).toMatch(/<span class="tl-target" id="y2025"><\/span>/);
    expect(res.text).not.toContain('id="y2024"');
    expect(res.text).not.toContain('E2024-0');
    // The rail: loaded years jump in page, older ones open the list there.
    expect(res.text).toMatch(
      /<a href="#y2026" data-year="2026" aria-current="location"\s*>2026<\/a/,
    );
    expect(res.text).toContain('<a href="#y2025" data-year="2025">2025</a>');
    expect(res.text).toContain(
      '<a href="/host/history?year=2026&amp;before=2024#y2023" data-year="2023">2023</a>',
    );
    expect(res.text).toMatch(
      /href="\/host\/history\?year=2026&amp;before=2025"\s*>Older events \(2024 and before\)/,
    );
    expect(res.text).not.toContain('Newer events');
    // Nothing paginates by ?page= any more.
    expect(res.text).not.toContain('class="pager"');
  });

  it('?before= opens the list from an older year, with Newer and no further Older', async () => {
    const req = await pagesApp(async () =>
      years({ 2026: 12, 2025: 24, 2024: 5, 2023: 5 }),
    );
    const sid = await signInWithDiscord(req);
    const res = await req
      .get('/host/history?year=2026&before=2025')
      .set('Cookie', sid);
    expect(res.text).toContain('E2024-0');
    expect(res.text).toContain('E2023-0');
    expect(res.text).not.toContain('E2026-0');
    expect(res.text).toMatch(
      /href="\/host\/history\?year=2026"\s*>↑ Newer events/,
    );
    expect(res.text).not.toContain('<p class="tl-more"');
    expect(res.text).toContain(
      '<a href="/host/history?year=2026#y2026" data-year="2026">2026</a>',
    );
    // A junk before is ignored: the newest chunk.
    const junks = await Promise.all(
      ['abc', '20255', '-1', '2025-01'].map((q) =>
        req
          .get(`/host/history?before=${encodeURIComponent(q)}`)
          .set('Cookie', sid),
      ),
    );
    for (const junk of junks) {
      expect(junk.status).toBe(200);
      expect(junk.text).toContain('E2026-0');
    }
  });

  it('one year has no rail', async () => {
    const req = await pagesApp(async () => years({ 2026: 3 }));
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host/history').set('Cookie', sid);
    expect(res.text).not.toContain('<nav class="year-rail"');
    expect(res.text).toContain('<div class="timeline" data-timeline>');
  });

  it('ships the timeline script with the page nonce, after the heat map one', async () => {
    const req = await pagesApp(async () => years({ 2026: 3 }));
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host/history').set('Cookie', sid);
    const scripts = res.text.match(/<script nonce="[^"]+">/g) ?? [];
    expect(scripts.length).toBeGreaterThanOrEqual(3);
    expect(res.text).toContain('window.__hostTimeline');
  });
});

describe('host history timeline edges', () => {
  it('files events by Pacific day: New Year’s Eve evening is the old year, a month’s last evening its month', async () => {
    const req = await pagesApp(async () => [
      // 2026-01-01T03:00Z is 7 PM on Dec 31, 2025 in Seattle.
      ev('1', '2026-01-01T03:00:00Z', 'NYE party'),
      // 2025-12-01T06:30Z is 10:30 PM on Nov 30, 2025.
      ev('2', '2025-12-01T06:30:00Z', 'Late November'),
      ev('3', '2026-03-01T19:00:00-08:00', 'Spring'),
    ]);
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host/history').set('Cookie', sid);
    const at2025 = res.text.indexOf(
      '<section class="tl-year" data-year="2025"',
    );
    const y2025 = res.text.slice(at2025);
    const y2026 = res.text.slice(
      res.text.indexOf('<section class="tl-year" data-year="2026"'),
      at2025,
    );
    expect(y2025).toContain('NYE party');
    expect(y2026).not.toContain('NYE party');
    expect(y2025).toMatch(/December\s*<span class="tl-count"\s*>1 event/);
    expect(y2025).toMatch(/November\s*<span class="tl-count"\s*>1 event/);
    expect(y2025).toContain('<span class="when">Wed, Dec 31</span>');
    expect(y2025).toContain('<span class="when">Sun, Nov 30</span>');
  });

  it('?before= that leads nowhere still has a way back, and one past the newest year is the whole list', async () => {
    const req = await pagesApp(async () => [
      ev('1', '2026-10-01T19:00:00-07:00', 'New one'),
      ev('2', '2024-10-01T19:00:00-07:00', 'Old one'),
    ]);
    const sid = await signInWithDiscord(req);
    const get = (q: string) =>
      req.get(`/host/history?before=${q}`).set('Cookie', sid);
    const [early, zero, future, gap, junk] = await Promise.all([
      get('2024'),
      get('0001'),
      get('2031'),
      get('2026'),
      get('20x5'),
    ]);
    for (const dead of [early, zero]) {
      expect(dead.status).toBe(200);
      expect(dead.text).toContain('No older events.');
      expect(dead.text).toMatch(
        /href="\/host\/history\?year=2026"\s*>↑ Newer events/,
      );
    }
    for (const whole of [future, junk]) {
      expect(whole.text).toContain('New one');
      expect(whole.text).not.toContain('Newer events');
    }
    // A year with no events (2025) starts at the next one that has some.
    const gapList = gap.text.slice(gap.text.indexOf('data-timeline>'));
    expect(gapList).toContain('Old one');
    expect(gapList).not.toContain('New one');
    expect(gap.text).toContain('Newer events');
  });

  it('the Older label names the next year that has events, across a gap', async () => {
    const many = Array.from({ length: 31 }, (_, i) =>
      ev(`n${i}`, `2026-0${1 + (i % 9)}-1${i % 9}T19:00:00-07:00`, `N${i}`),
    );
    const req = await pagesApp(async () => [
      ...many,
      ev('o', '2021-05-01T19:00:00-07:00', 'Long ago'),
    ]);
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host/history').set('Cookie', sid);
    expect(res.text).toMatch(
      /href="\/host\/history\?year=2026&amp;before=2026"\s*>Older events \(2021 and before\)/,
    );
  });
});

describe('timelineChunk', () => {
  const mk = (y: number, n: number) =>
    Array.from({ length: n }, (_, i) =>
      ev(
        `${y}-${i}`,
        `${y}-06-${String(1 + (i % 28)).padStart(2, '0')}T12:00:00-07:00`,
        'x',
      ),
    );
  it('takes whole years until the minimum, and says where the next starts', () => {
    const events = [
      ...mk(2026, 10),
      ...mk(2025, 10),
      ...mk(2024, 10),
      ...mk(2022, 1),
    ];
    expect(timelineChunk(events, undefined, 15)).toMatchObject({
      years: [2026, 2025],
      nextBefore: 2025,
    });
    expect(timelineChunk(events, undefined, 15).events).toHaveLength(20);
    expect(timelineChunk(events, 2025, 15)).toMatchObject({
      years: [2024, 2022],
      nextBefore: undefined,
    });
    // A year bigger than the minimum is still whole.
    expect(timelineChunk(mk(2026, 40), undefined, 15).events).toHaveLength(40);
    expect(timelineChunk([], undefined)).toEqual({
      years: [],
      events: [],
      nextBefore: undefined,
    });
  });
  it('beforeParam takes four digits only', () => {
    expect(beforeParam('2025')).toBe(2025);
    for (const v of [undefined, '', '205', '20255', ['2025'], '2025x']) {
      expect(beforeParam(v)).toBeUndefined();
    }
  });
});

describe('host calendar thumbnails', () => {
  it('shows each event’s Meetup thumbnail, lazy and sized, with a placeholder otherwise', async () => {
    const photo =
      'https://secure.meetupstatic.com/photos/event/d/2/2/5/thumb_536933797.jpeg';
    const req = await pagesApp(async (filter) => {
      if (!filter.status?.includes('ACTIVE')) {
        return [];
      }
      return [
        {
          ...ev('1', '2026-11-10T19:00:00-08:00', 'With photo'),
          photoUrl: photo,
        },
        ev('2', '2026-11-10T20:00:00-08:00', 'No photo'),
        {
          ...ev('3', '2026-11-11T20:00:00-08:00', 'Elsewhere'),
          photoUrl: 'https://evil.example/x.jpg',
        },
        {
          ...ev('4', '2026-11-12T20:00:00-08:00', 'Plain http'),
          photoUrl: 'http://secure.meetupstatic.com/x.jpg',
        },
        {
          ...ev('5', '2026-11-13T20:00:00-08:00', 'Look-alike'),
          photoUrl: 'https://secure.meetupstatic.com.evil.example/x.jpg',
        },
        {
          ...ev('6', '2026-11-14T20:00:00-08:00', 'Userinfo'),
          photoUrl: 'https://me@secure.meetupstatic.com/x.jpg',
        },
        {
          ...ev('7', '2026-11-15T20:00:00-08:00', 'Port'),
          photoUrl: 'https://secure.meetupstatic.com:444/x.jpg',
        },
      ];
    });
    const sid = await signInWithDiscord(req);
    const res = await req.get('/host/calendar').set('Cookie', sid);
    const img =
      /<img\s+class="ev-thumb"\s+src="([^"]+)"\s+alt=""\s+width="48"\s+height="48"\s+loading="lazy"/;
    expect(res.text.match(img)?.[1]).toBe(photo);
    expect(res.text.match(/<img\s+class="ev-thumb"/g)).toHaveLength(1);
    expect(
      res.text.match(
        /<span class="ev-thumb ev-thumb-none" aria-hidden="true"><\/span>/g,
      ),
    ).toHaveLength(6);
    expect(res.text).not.toContain('evil.example');
    expect(res.text).not.toContain('me@secure');
    expect(res.text).not.toContain(':444/');
    expect(res.text).not.toContain('http://secure.meetupstatic.com');
    // The host CSP admits that image host and same-origin fetch, nothing more.
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("img-src 'self' https://secure.meetupstatic.com;");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).not.toMatch(/img-src[^;]*\*/);
  });
});

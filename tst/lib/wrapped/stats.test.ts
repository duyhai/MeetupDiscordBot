import { describe, expect, it } from 'vitest';

import {
  FIRST_EVENTS_PER_TYPE,
  HostedEvent,
  TOP_HOSTED,
  WrappedEvent,
  WrappedInput,
  computeWrapped,
  isInYear,
} from '../../../src/lib/wrapped/stats.js';

function ev(id: string, iso: string, title = `Event ${id}`): WrappedEvent {
  return {
    id,
    title,
    dateTime: iso,
    eventUrl: `https://www.meetup.com/e/${id}/`,
  };
}

const hosted = (event: WrappedEvent, attendance = 0): HostedEvent => ({
  ...event,
  attendance,
});

/** A top type as computeWrapped returns it: no cohort yet (build.ts fills it). */
const topType = (
  type: string,
  count: number,
  firstEvents: WrappedEvent[] = [],
) => ({ type, count, firstEvents, cohort: { named: [], otherCount: 0 } });

const hike = ev('1', '2024-03-02T10:00:00-08:00', 'Hike');
const trivia = ev('2', '2026-05-10T19:00:00-07:00', 'Trivia');
const hotPot = ev('3', '2026-11-20T19:00:00-08:00', 'Hot Pot');
const future = ev('4', '2027-01-05T19:00:00-08:00', 'Future');

function input(overrides: Partial<WrappedInput> = {}): WrappedInput {
  return {
    year: 2026,
    selfMeetupId: 'self',
    attended: [],
    hosted: [],
    attendeesByEvent: {},
    ...overrides,
  };
}

describe('isInYear', () => {
  it('treats a UTC-next-year event that is still 31 Dec in LA as this year', () => {
    expect(isInYear('2027-01-01T05:00:00Z', 2026)).toBe(true);
    expect(isInYear('2027-01-01T09:00:00Z', 2026)).toBe(false);
    expect(isInYear('2026-01-01T07:59:00Z', 2026)).toBe(false);
  });
});

describe('computeWrapped', () => {
  it('counts this year and all-time as of 31 Dec of the year', () => {
    const { stats } = computeWrapped(
      input({ attended: [future, hotPot, hike, trivia] }),
    );

    expect(stats.year).toBe(2026);
    expect(stats.attendedThisYear).toBe(2);
    expect(stats.attendedAllTime).toBe(3);
    expect(stats.firstEvent).toEqual(hike);
  });

  it('has empty fun stats for a year with no events', () => {
    const { stats, companions } = computeWrapped(
      input({ attended: [hike], attendeesByEvent: { '1': ['self', 'x'] } }),
    );

    expect(stats.attendedThisYear).toBe(0);
    expect(stats.attendedAllTime).toBe(1);
    expect(stats.firstEvent).toEqual(hike);
    expect(stats.topTypes).toEqual([]);
    expect(stats.busiestMonth).toBeNull();
    expect(stats.longestStreakMonths).toBe(0);
    expect(stats.hosting).toBeNull();
    expect(companions).toEqual([]);
  });

  it('lists every year with a counted event, not cut off at the Wrapped year', () => {
    const { stats } = computeWrapped(
      input({
        attended: [
          future,
          hotPot,
          hike,
          trivia,
          ev('9', '2025-06-01T19:00:00-07:00', 'Cancelled: Picnic'),
        ],
      }),
    );

    expect(stats.activeYears).toEqual([2024, 2026, 2027]);
  });

  it('has no active years with no events', () => {
    expect(computeWrapped(input()).stats.activeYears).toEqual([]);
  });

  it('counts a hosted event as attended, once', () => {
    const games = ev('7', '2026-02-01T19:00:00-08:00', 'Board Game Night');
    const { stats } = computeWrapped(
      input({ attended: [games], hosted: [hosted(games, 8)] }),
    );

    expect(stats.attendedThisYear).toBe(1);
    expect(stats.attendedAllTime).toBe(1);
    expect(stats.hosting).toEqual({
      thisYear: 1,
      allTime: 1,
      topThisYear: [{ event: games, attendance: 8 }],
      allTimeBest: { event: games, attendance: 8 },
    });
    expect(stats.topTypes).toEqual([topType('games', 1, [games])]);
  });

  it('builds the year from hosted events alone', () => {
    const games = ev('7', '2026-02-01T19:00:00-08:00', 'Board Game Night');
    const old = ev('8', '2025-02-01T19:00:00-08:00', 'Old Dinner');
    const { stats } = computeWrapped(
      input({ hosted: [hosted(games), hosted(old)] }),
    );

    expect(stats.attendedThisYear).toBe(1);
    expect(stats.attendedAllTime).toBe(2);
    expect(stats.firstEvent).toEqual(old);
    expect(stats.hosting).toMatchObject({ thisYear: 1, allTime: 2 });
  });

  it('breaks top-type ties by EVENT_TYPES order and keeps at most three', () => {
    const { stats } = computeWrapped(
      input({
        attended: [
          ev('a', '2026-01-10T19:00:00-08:00', 'Dinner'),
          ev('b', '2026-01-11T19:00:00-08:00', 'Trivia'),
          ev('c', '2026-01-12T19:00:00-08:00', 'Hike'),
          ev('d', '2026-01-13T19:00:00-08:00', 'Karaoke'),
          ev('e', '2026-01-14T19:00:00-08:00', 'Karaoke again'),
        ],
      }),
    );

    expect(stats.topTypes.map(({ type, count }) => ({ type, count }))).toEqual([
      { type: 'nightlife', count: 2 },
      { type: 'games', count: 1 },
      { type: 'food', count: 1 },
    ]);
  });

  it('gives a busiest-month tie to the earliest month', () => {
    const { stats } = computeWrapped(
      input({
        attended: [
          ev('a', '2026-06-01T19:00:00-07:00'),
          ev('b', '2026-06-02T19:00:00-07:00'),
          ev('c', '2026-03-01T19:00:00-08:00'),
          ev('d', '2026-03-02T19:00:00-08:00'),
          ev('e', '2026-01-02T19:00:00-08:00'),
        ],
      }),
    );

    expect(stats.busiestMonth).toMatchObject({ month: 2, count: 2 });
  });

  it("lists the busiest month's events in date order, cancelled dropped", () => {
    const a = ev('a', '2026-06-20T19:00:00-07:00');
    const b = ev('b', '2026-06-02T19:00:00-07:00');
    const m = ev('m', '2026-06-11T19:00:00-07:00');
    const { stats } = computeWrapped(
      input({
        attended: [
          a,
          b,
          m,
          ev('x', '2026-06-10T19:00:00-07:00', 'Cancelled: Picnic'),
          ev('c', '2026-03-01T19:00:00-08:00'),
          ev('d', '2026-03-02T19:00:00-08:00'),
        ],
      }),
    );

    expect(stats.busiestMonth).toEqual({
      month: 5,
      count: 3,
      events: [b, m, a],
    });
  });

  it('ranks hosted events this year by attendance, then earliest date, at most five', () => {
    const at = (id: string, day: number, attendance: number) =>
      hosted(
        ev(id, `2026-03-${String(day).padStart(2, '0')}T19:00:00-08:00`),
        attendance,
      );
    const list = [
      at('h1', 1, 9),
      at('h2', 2, 9),
      at('h3', 3, 7),
      at('h4', 4, 12),
      at('h5', 5, 3),
      at('h6', 6, 5),
    ];
    const { stats } = computeWrapped(input({ hosted: list }));

    expect(TOP_HOSTED).toBe(5);
    expect(stats.hosting?.topThisYear.map((h) => h.event.id)).toEqual([
      'h4',
      'h1',
      'h2',
      'h3',
      'h6',
    ]);
    expect(stats.hosting?.topThisYear[0].attendance).toBe(12);
  });

  it('finds the all-time best hosted event as of 31 Dec of the year', () => {
    const old = ev('o', '2024-05-01T19:00:00-07:00');
    const now = ev('n', '2026-05-01T19:00:00-07:00');
    const later = ev('l', '2027-05-01T19:00:00-07:00');
    const { stats } = computeWrapped(
      input({ hosted: [hosted(later, 50), hosted(now, 20), hosted(old, 30)] }),
    );

    expect(stats.hosting?.allTimeBest).toEqual({ event: old, attendance: 30 });
    expect(stats.hosting?.topThisYear).toEqual([
      { event: now, attendance: 20 },
    ]);
  });

  it('has no hosting rankings for a member who never hosted', () => {
    expect(
      computeWrapped(input({ attended: [trivia] })).stats.hosting,
    ).toBeNull();
  });

  it('lists the first ten events ever of each top type, earliest first, all-time', () => {
    const games = Array.from({ length: 12 }, (_, i) =>
      ev(
        `g${i}`,
        `${2023 + Math.floor(i / 3)}-0${1 + (i % 3)}-05T19:00:00-08:00`,
        'Trivia',
      ),
    );
    const { stats } = computeWrapped(
      input({ attended: [...games].reverse().concat(hotPot) }),
    );

    expect(FIRST_EVENTS_PER_TYPE).toBe(10);
    expect(stats.topTypes[0]).toMatchObject({ type: 'games' });
    expect(stats.topTypes[0].firstEvents).toEqual(games.slice(0, 10));
    expect(stats.topTypes[0].cohort).toEqual({ named: [], otherCount: 0 });
    expect(stats.topTypes[1]).toEqual(topType('food', 1, [hotPot]));
  });

  it('has fewer than ten first events when the member has fewer', () => {
    const { stats } = computeWrapped(input({ attended: [hike, trivia] }));

    expect(stats.topTypes.find((t) => t.type === 'games')?.firstEvents).toEqual(
      [trivia],
    );
  });

  it('no first events when nothing counts', () => {
    const { stats } = computeWrapped(
      input({
        attended: [ev('x', '2026-06-10T19:00:00-07:00', 'Cancelled: Trivia')],
      }),
    );

    expect(stats.topTypes).toEqual([]);
  });

  it("carries each companion's shared event ids in date order", () => {
    const { companions } = computeWrapped(
      input({
        attended: [hotPot, trivia],
        attendeesByEvent: { '3': ['self', '7'], '2': ['self', '7', '8'] },
      }),
    );

    expect(companions).toEqual([
      { meetupId: '7', sharedCount: 2, sharedEventIds: ['2', '3'] },
      { meetupId: '8', sharedCount: 1, sharedEventIds: ['2'] },
    ]);
  });

  it('measures the longest run of consecutive months', () => {
    const { stats } = computeWrapped(
      input({
        attended: ['01', '02', '03', '06', '07'].map((m) =>
          ev(m, `2026-${m}-15T19:00:00-08:00`),
        ),
      }),
    );

    expect(stats.longestStreakMonths).toBe(3);
  });

  it('drops cancelled titles from counts and companions', () => {
    const cancelled = ev(
      '9',
      '2026-04-01T19:00:00-07:00',
      'CANCELLED - Picnic',
    );
    const { stats, companions } = computeWrapped(
      input({
        attended: [cancelled, trivia],
        attendeesByEvent: { '9': ['self', 'ghost'], '2': ['self'] },
      }),
    );

    expect(stats.attendedThisYear).toBe(1);
    expect(companions).toEqual([]);
  });

  it('an Open House hosted counts as attended but not as hosted (the shared rule)', () => {
    const openHouse = ev(
      '8',
      '2026-05-01T19:00:00-07:00',
      '[Open House] Pickleball',
    );
    const { stats } = computeWrapped(
      input({
        attended: [],
        hosted: [hosted(openHouse), hosted(trivia)],
        attendeesByEvent: {},
      }),
    );
    expect(stats.attendedThisYear).toBe(2);
    expect(stats.hosting).toMatchObject({ thisYear: 1, allTime: 1 });
  });

  it('ranks companions by shared count, then by Meetup id, excluding self', () => {
    const e1 = ev('e1', '2026-02-01T19:00:00-08:00');
    const e2 = ev('e2', '2026-03-01T19:00:00-08:00');
    const e3 = ev('e3', '2026-04-01T19:00:00-07:00');
    const { companions } = computeWrapped(
      input({
        attended: [e1, e2, e3],
        attendeesByEvent: {
          e1: ['self', '10', '9'],
          e2: ['self', '10', '2'],
          e3: ['9', 'self'],
        },
      }),
    );

    expect(companions).toEqual([
      { meetupId: '9', sharedCount: 2, sharedEventIds: ['e1', 'e3'] },
      { meetupId: '10', sharedCount: 2, sharedEventIds: ['e1', 'e2'] },
      { meetupId: '2', sharedCount: 1, sharedEventIds: ['e2'] },
    ]);
  });

  it('has no companions when nobody else was there', () => {
    const { companions } = computeWrapped(
      input({ attended: [trivia], attendeesByEvent: { '2': ['self'] } }),
    );

    expect(companions).toEqual([]);
  });

  it('ignores attendee lists for events outside the year', () => {
    const { companions } = computeWrapped(
      input({
        attended: [hike, trivia],
        attendeesByEvent: { '1': ['self', 'old'], '2': ['self', 'new'] },
      }),
    );

    expect(companions).toEqual([
      { meetupId: 'new', sharedCount: 1, sharedEventIds: ['2'] },
    ]);
  });
});

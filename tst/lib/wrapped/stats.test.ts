import { describe, expect, it } from 'vitest';

import {
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

  it('counts a hosted event as attended, once', () => {
    const games = ev('7', '2026-02-01T19:00:00-08:00', 'Board Game Night');
    const { stats } = computeWrapped(
      input({ attended: [games], hosted: [games] }),
    );

    expect(stats.attendedThisYear).toBe(1);
    expect(stats.attendedAllTime).toBe(1);
    expect(stats.hosting).toEqual({ thisYear: 1, allTime: 1 });
    expect(stats.topTypes).toEqual([{ type: 'games', count: 1 }]);
  });

  it('builds the year from hosted events alone', () => {
    const games = ev('7', '2026-02-01T19:00:00-08:00', 'Board Game Night');
    const old = ev('8', '2025-02-01T19:00:00-08:00', 'Old Dinner');
    const { stats } = computeWrapped(input({ hosted: [games, old] }));

    expect(stats.attendedThisYear).toBe(1);
    expect(stats.attendedAllTime).toBe(2);
    expect(stats.firstEvent).toEqual(old);
    expect(stats.hosting).toEqual({ thisYear: 1, allTime: 2 });
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

    expect(stats.topTypes).toEqual([
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

    expect(stats.busiestMonth).toEqual({ month: 2, count: 2 });
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
      { meetupId: '9', sharedCount: 2 },
      { meetupId: '10', sharedCount: 2 },
      { meetupId: '2', sharedCount: 1 },
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

    expect(companions).toEqual([{ meetupId: 'new', sharedCount: 1 }]);
  });
});

import { describe, expect, it } from 'vitest';

import {
  LeaderboardEvent,
  eventsByHost,
  medalsFor,
  mondayOf,
  monthCounts,
  monthsToAward,
  rank,
  streaksOf,
} from '../../../src/lib/leaderboard/standings.js';

let seq = 0;
const ev = (
  at: string,
  hostIds: string[],
  title = 'Board games',
): LeaderboardEvent => {
  seq += 1;
  return {
    id: String(seq),
    title,
    dateTime: new Date(at),
    status: 'PAST',
    hostIds,
  };
};

describe('monthCounts', () => {
  it('counts every co-host once per event, by Pacific month, skipping cancelled and Open House events', () => {
    const events = [
      ev('2026-10-05T02:00:00Z', ['1', '2', '1']),
      // 2026-11-01 01:00 UTC is still Oct 31 in Pacific.
      ev('2026-11-01T01:00:00Z', ['1']),
      ev('2026-11-02T01:00:00Z', ['1']),
      ev('2026-10-10T18:00:00Z', ['2'], 'Hike (cancelled)'),
      ev('2026-10-11T18:00:00Z', ['2'], '[Open House] Drop in'),
    ];
    expect(monthCounts(events, '2026-10')).toEqual(
      new Map([
        ['1', 2],
        ['2', 1],
      ]),
    );
    expect(monthCounts(events, '2026-11')).toEqual(new Map([['1', 1]]));
  });
});

describe('rank and medals', () => {
  it('shares places on ties and skips the next (1, 1, 3), listing ties by name', () => {
    const names: Record<string, string> = {
      a: 'Zed',
      b: 'Amy',
      c: 'Cy',
      d: 'Di',
    };
    const standings = rank(
      new Map([
        ['a', 4],
        ['b', 4],
        ['c', 2],
        ['d', 1],
        ['e', 0],
      ]),
      (id) => names[id] ?? '',
    );
    expect(standings).toEqual([
      { memberId: 'b', events: 4, place: 1 },
      { memberId: 'a', events: 4, place: 1 },
      { memberId: 'c', events: 2, place: 3 },
      { memberId: 'd', events: 1, place: 4 },
    ]);
    expect(medalsFor('2026-10', standings)).toEqual([
      { month: '2026-10', memberId: 'b', place: 1, events: 4 },
      { month: '2026-10', memberId: 'a', place: 1, events: 4 },
      { month: '2026-10', memberId: 'c', place: 3, events: 2 },
    ]);
  });

  it('gives every host tied for third a bronze', () => {
    const standings = rank(
      new Map([
        ['a', 5],
        ['b', 3],
        ['c', 2],
        ['d', 2],
      ]),
    );
    expect(medalsFor('2026-10', standings).map((m) => m.place)).toEqual([
      1, 2, 3, 3,
    ]);
  });
});

describe('monthsToAward', () => {
  const events = [
    ev('2026-08-10T18:00:00Z', ['1']),
    ev('2026-10-10T18:00:00Z', ['1']),
  ];

  it('awards each month from the first, once it ended two days before the last listing', () => {
    // October ends at Nov 1 00:00 Pacific (07:00 UTC); +2 days is Nov 3 07:00 UTC.
    expect(
      monthsToAward(events, new Set(), new Date('2026-11-03T06:59:00Z')),
    ).toEqual(['2026-08', '2026-09']);
    expect(
      monthsToAward(
        events,
        new Set(['2026-08']),
        new Date('2026-11-03T07:00:00Z'),
      ),
    ).toEqual(['2026-09', '2026-10']);
  });

  it('awards nothing without counted events', () => {
    expect(
      monthsToAward([], new Set(), new Date('2026-11-20T00:00:00Z')),
    ).toEqual([]);
  });
});

describe('streaksOf', () => {
  // Pacific evenings: 03:00 UTC the next day is 19:00 or 20:00 Pacific.
  const at = (day: string) => {
    const next = new Date(`${day}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return ev(`${next.toISOString().slice(0, 10)}T03:00:00Z`, ['1']);
  };

  it('counts Pacific days in a row and keeps a streak alive through today', () => {
    const events = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-03'].map(
      at,
    );
    expect(streaksOf(events, '2026-11-04').daily).toEqual({
      current: 3,
      best: 3,
    });
    expect(streaksOf(events, '2026-11-03').daily.current).toBe(3);
    // A whole day (Nov 4) passed without hosting.
    expect(streaksOf(events, '2026-11-05').daily).toEqual({
      current: 0,
      best: 3,
    });
  });

  it('keeps the best run apart from the current one', () => {
    const events = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-11-02'].map(
      at,
    );
    expect(streaksOf(events, '2026-11-02').daily).toEqual({
      current: 1,
      best: 3,
    });
  });

  it('counts Monday-first weeks in a row, alive through last week', () => {
    // Weeks of Oct 19, Oct 26 (a Sunday, Nov 1), Nov 2; then a gap.
    const events = ['2026-10-20', '2026-11-01', '2026-11-02'].map(at);
    expect(streaksOf(events, '2026-11-12').weekly).toEqual({
      current: 3,
      best: 3,
    });
    expect(streaksOf(events, '2026-11-16').weekly.current).toBe(0);
  });

  it('is zero with no events', () => {
    expect(streaksOf([], '2026-11-04')).toEqual({
      daily: { current: 0, best: 0 },
      weekly: { current: 0, best: 0 },
    });
  });
});

describe('helpers', () => {
  it('mondayOf: Sunday belongs to the week before', () => {
    expect(mondayOf('2026-11-01')).toBe('2026-10-26');
    expect(mondayOf('2026-11-02')).toBe('2026-11-02');
  });

  it('eventsByHost dedupes a host within an event and drops uncounted ones', () => {
    const byHost = eventsByHost([
      ev('2026-10-05T02:00:00Z', ['1', '1', '2']),
      ev('2026-10-06T02:00:00Z', ['1'], 'Cancelled: picnic'),
    ]);
    expect(byHost.get('1')).toHaveLength(1);
    expect(byHost.get('2')).toHaveLength(1);
  });
});

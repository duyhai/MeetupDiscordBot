import { describe, expect, it } from 'vitest';

import {
  LeaderboardEvent,
  MAX_AWARD_MONTHS,
  countsByMonth,
  eventsByHost,
  firstMonthOf,
  medalsFor,
  mondayOf,
  monthsToAward,
  rank,
  streaksOf,
} from '../../../src/lib/leaderboard/standings.js';

let seq = 0;
/** An event on a Pacific day (the store computes the day in SQL). */
const ev = (
  day: string,
  hostIds: string[],
  title = 'Board games',
): LeaderboardEvent => {
  seq += 1;
  return { id: String(seq), title, status: 'PAST', hostIds, day };
};

describe('countsByMonth', () => {
  it('counts every co-host once per event, by Pacific month, skipping cancelled and Open House events', () => {
    const byMonth = countsByMonth([
      ev('2026-10-04', ['1', '2', '1']),
      ev('2026-10-31', ['1']),
      ev('2026-11-01', ['1']),
      ev('2026-10-10', ['2'], 'Hike (cancelled)'),
      ev('2026-10-11', ['2'], '[Open House] Drop in'),
    ]);
    expect(byMonth.get('2026-10')).toEqual(
      new Map([
        ['1', 2],
        ['2', 1],
      ]),
    );
    expect(byMonth.get('2026-11')).toEqual(new Map([['1', 1]]));
  });

  it('buckets ten years of a busy group in one quick pass', () => {
    const events: LeaderboardEvent[] = [];
    for (let m = 0; m < 120; m += 1) {
      const month = `${2017 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
      for (let i = 0; i < 100; i += 1) {
        events.push(
          ev(`${month}-${String((i % 28) + 1).padStart(2, '0')}`, [
            String(i % 30),
            String((i + 7) % 30),
          ]),
        );
      }
    }
    const started = performance.now();
    const byMonth = countsByMonth(events);
    const byHost = eventsByHost(events);
    byHost.forEach((hostEvents) => streaksOf(hostEvents, '2026-12-31'));
    expect(byMonth.size).toBe(120);
    // 12,000 events: well under a second even on a slow dyno (measured ~30 ms).
    expect(performance.now() - started).toBeLessThan(1000);
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
  it('awards each month from the first, once it ended two days (48 h) before the last complete listing', () => {
    // October ends at Nov 1 00:00 PDT (07:00 UTC); +48 h is Nov 3 07:00 UTC,
    // across the Nov 1 DST change.
    expect(
      monthsToAward('2026-08', new Set(), new Date('2026-11-03T06:59:00Z')),
    ).toEqual(['2026-08', '2026-09']);
    expect(
      monthsToAward(
        '2026-08',
        new Set(['2026-08']),
        new Date('2026-11-03T07:00:00Z'),
      ),
    ).toEqual(['2026-09', '2026-10']);
  });

  it('handles the March DST change: February ends at Mar 1 00:00 PST (08:00 UTC)', () => {
    expect(
      monthsToAward('2026-02', new Set(), new Date('2026-03-03T07:59:00Z')),
    ).toEqual([]);
    expect(
      monthsToAward('2026-02', new Set(), new Date('2026-03-03T08:00:00Z')),
    ).toEqual(['2026-02']);
  });

  it('takes at most the oldest MAX_AWARD_MONTHS a read, so the backfill is spread out', () => {
    const due = monthsToAward(
      '2018-01',
      new Set(),
      new Date('2026-11-17T00:00:00Z'),
    );
    expect(due).toHaveLength(MAX_AWARD_MONTHS);
    expect(due[0]).toBe('2018-01');
    expect(due[11]).toBe('2018-12');
  });

  it('awards nothing without counted events', () => {
    expect(
      monthsToAward(undefined, new Set(), new Date('2026-11-20T00:00:00Z')),
    ).toEqual([]);
    expect(firstMonthOf([])).toBeUndefined();
    expect(
      firstMonthOf([ev('2026-03-01', ['1']), ev('2025-12-31', ['1'])]),
    ).toBe('2025-12');
  });
});

describe('streaksOf', () => {
  it('counts Pacific days in a row and keeps a streak alive through today', () => {
    const events = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-03'].map(
      (d) => ev(d, ['1']),
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
      (d) => ev(d, ['1']),
    );
    expect(streaksOf(events, '2026-11-02').daily).toEqual({
      current: 1,
      best: 3,
    });
  });

  it('counts Monday-first weeks in a row, alive through last week', () => {
    // Weeks of Oct 19, Oct 26 (a Sunday, Nov 1), Nov 2; then a gap.
    const events = ['2026-10-20', '2026-11-01', '2026-11-02'].map((d) =>
      ev(d, ['1']),
    );
    expect(streaksOf(events, '2026-11-12').weekly).toEqual({
      current: 3,
      best: 3,
    });
    expect(streaksOf(events, '2026-11-16').weekly.current).toBe(0);
  });

  it('crosses the March DST change and a year end', () => {
    const days = ['2026-03-07', '2026-03-08', '2026-03-09'];
    expect(
      streaksOf(
        days.map((d) => ev(d, ['1'])),
        '2026-03-09',
      ).daily,
    ).toEqual({ current: 3, best: 3 });
    const newYear = ['2025-12-31', '2026-01-01'];
    expect(
      streaksOf(
        newYear.map((d) => ev(d, ['1'])),
        '2026-01-01',
      ).daily.current,
    ).toBe(2);
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
      ev('2026-10-05', ['1', '1', '2']),
      ev('2026-10-06', ['1'], 'Cancelled: picnic'),
    ]);
    expect(byHost.get('1')).toHaveLength(1);
    expect(byHost.get('2')).toHaveLength(1);
  });
});

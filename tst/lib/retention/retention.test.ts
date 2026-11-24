import { describe, expect, it, vi } from 'vitest';

import type { SnapshotRun } from '../../../src/lib/repositories/postgresSnapshotRepository.js';
import {
  CohortMonth,
  RetentionAggregates,
  addMonths,
  createRetentionLoader,
  headlines,
  isMatured,
  ladder,
  lastMatured,
  monthsBetween,
  percent,
  sumCohorts,
  thirdEventFollowUp,
  yearRows,
} from '../../../src/lib/retention/retention.js';

const cohort = (
  month: string,
  over: Partial<CohortMonth> = {},
): CohortMonth => ({
  month,
  members: 10,
  second90: 6,
  third90: 4,
  yearOn: 3,
  reached2: 7,
  reached3: 5,
  reached4: 4,
  reached5: 3,
  reached6: 2,
  reached7: 1,
  laterThird90: 3,
  laterNoThird90: 1,
  ...over,
});

const view = (
  asOf: string,
  cohorts: CohortMonth[],
  years: RetentionAggregates['years'] = [],
) => ({ asOf, cohorts, months: [], years });

describe('months', () => {
  it('addMonths crosses years both ways', () => {
    expect(addMonths('2025-11', 3)).toBe('2026-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-03', -24)).toBe('2024-03');
    expect(addMonths('2026-12', 0)).toBe('2026-12');
  });

  it('monthsBetween is inclusive, and empty when the end is first', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(monthsBetween('2026-02', '2026-01')).toEqual([]);
  });
});

describe('matured months', () => {
  it('a month is matured only once its last day plus the window is before the as-of day', () => {
    // July's last day is the 31st; day 90 after it is October 29.
    expect(isMatured('2026-07', '2026-10-29', 90)).toBe(false);
    expect(isMatured('2026-07', '2026-10-30', 90)).toBe(true);
    // February in a leap year: Feb 29 + 90 is May 29.
    expect(isMatured('2024-02', '2024-05-29', 90)).toBe(false);
    expect(isMatured('2024-02', '2024-05-30', 90)).toBe(true);
    // A year: September 30, 2025 + 365 is September 30, 2026.
    expect(isMatured('2025-09', '2026-09-30', 365)).toBe(false);
    expect(isMatured('2025-09', '2026-10-01', 365)).toBe(true);
  });

  it('junk is never matured', () => {
    expect(isMatured('2026', '2026-10-30', 90)).toBe(false);
    expect(isMatured('2026-07', 'soon', 90)).toBe(false);
  });

  it('lastMatured walks back from the as-of month', () => {
    expect(lastMatured('2026-10-05', 90)).toBe('2026-06');
    expect(lastMatured('2026-10-30', 90)).toBe('2026-07');
    expect(lastMatured('2026-10-05', 365)).toBe('2025-09');
  });
});

describe('percent', () => {
  it('rounds to a whole number, and is undefined with nobody to count', () => {
    expect(percent({ count: 1, of: 3 })).toBe(33);
    expect(percent({ count: 7, of: 8 })).toBe(88);
    expect(percent({ count: 0, of: 5 })).toBe(0);
    expect(percent({ count: 0, of: 0 })).toBeUndefined();
  });
});

describe('sumCohorts', () => {
  it('adds the months in the range, ends included, and reads junk as zero', () => {
    const sums = sumCohorts(
      [
        cohort('2025-01'),
        cohort('2025-02', { members: 5 }),
        cohort('2025-03', { members: Number.NaN, second90: -4 }),
        cohort('2025-04'),
      ],
      '2025-02',
      '2025-03',
    );
    expect(sums.members).toBe(5);
    expect(sums.second90).toBe(6);
    expect(sums.third90).toBe(8);
  });
});

describe('headlines', () => {
  const months = monthsBetween('2023-01', '2026-10');

  it('each uses the latest 12 matured months and the 12 before', () => {
    const { third90, second90, yearOn } = headlines(
      view(
        '2026-10-05',
        months.map((m) =>
          // The months that have not matured would double the rate if counted.
          cohort(m, m > '2026-06' ? { third90: 10, second90: 10 } : {}),
        ),
      ),
    );
    expect(third90).toEqual({
      first: '2025-07',
      last: '2026-06',
      months: 12,
      rate: { count: 48, of: 120 },
      previousFirst: '2024-07',
      previousLast: '2025-06',
      previousMonths: 12,
      previous: { count: 48, of: 120 },
    });
    expect(second90.rate).toEqual({ count: 72, of: 120 });
    expect([yearOn.first, yearOn.last]).toEqual(['2024-10', '2025-09']);
    expect(yearOn.rate).toEqual({ count: 36, of: 120 });
    expect([yearOn.previousFirst, yearOn.previousLast]).toEqual([
      '2023-10',
      '2024-09',
    ]);
  });

  it('with nothing stored the rates count nobody, over no months', () => {
    const { third90 } = headlines(view('2026-10-05', []));
    expect(third90.rate).toEqual({ count: 0, of: 0 });
    expect(third90.previous).toEqual({ count: 0, of: 0 });
    expect([third90.months, third90.previousMonths]).toEqual([0, 0]);
  });

  it('a window the data only partly fills names the months it really covers', () => {
    // Data from March 2026; the 90-day window would be July 2025 to June 2026.
    const young = headlines(
      view(
        '2026-10-05',
        monthsBetween('2026-03', '2026-10').map((m) => cohort(m)),
      ),
    );
    expect(young.third90).toMatchObject({
      first: '2026-03',
      last: '2026-06',
      months: 4,
      rate: { count: 16, of: 40 },
      previousMonths: 0,
      previous: { count: 0, of: 0 },
    });
    // Nothing has had a year yet.
    expect(young.yearOn).toMatchObject({ months: 0, rate: { of: 0 } });
    // Data from January 2025: the earlier window is partly filled.
    const older = headlines(
      view(
        '2026-10-05',
        monthsBetween('2025-01', '2026-10').map((m) => cohort(m)),
      ),
    );
    expect(older.third90).toMatchObject({
      first: '2025-07',
      months: 12,
      previousFirst: '2025-01',
      previousLast: '2025-06',
      previousMonths: 6,
      previous: { count: 24, of: 60 },
    });
  });
});

describe('ladder', () => {
  it('each step is those who reached the next event, of those who reached this one', () => {
    const steps = ladder(sumCohorts([cohort('2025-01')], '2025-01', '2025-01'));
    expect(steps.map((s) => [s.events, s.rate.count, s.rate.of])).toEqual([
      ['1', 7, 10],
      ['2', 5, 7],
      ['3', 4, 5],
      ['4', 3, 4],
      ['5', 2, 3],
      // Members, like every other step: 2 reached a sixth, 1 a seventh.
      ['6', 1, 2],
    ]);
  });
});

describe('yearRows', () => {
  const rows = yearRows(
    view(
      '2026-10-05',
      [
        ...monthsBetween('2023-01', '2023-12').map((m) => cohort(m)),
        cohort('2025-05'),
        cohort('2026-08'),
      ],
      [
        { cohort: 2023, year: 2023, members: 120 },
        { cohort: 2023, year: 2024, members: 60 },
        { cohort: 2023, year: 2026, members: 30 },
        { cohort: 2025, year: 2026, members: 4 },
      ],
    ),
  );

  it('one row per first-event year, oldest first, with the lifetime shares', () => {
    expect(rows.map((r) => [r.year, r.members])).toEqual([
      [2023, 120],
      [2025, 10],
      [2026, 10],
    ]);
    expect(rows[0].oneOnly).toEqual({ count: 36, of: 120 });
    expect(rows[0].fiveOrMore).toEqual({ count: 36, of: 120 });
    expect(rows[0].steps).toEqual([
      { count: 84, of: 120 },
      { count: 60, of: 84 },
      { count: 48, of: 60 },
    ]);
  });

  it('following years are final, so far (the as-of year) or still to come', () => {
    expect(rows[0].following.map((f) => [f.state, f.rate.count])).toEqual([
      ['final', 60],
      // Nobody from 2023 attended in 2025: a real zero, not a gap.
      ['final', 0],
      ['so-far', 30],
      ['future', 0],
      ['future', 0],
    ]);
    expect(rows[1].following.map((f) => f.state)).toEqual([
      'so-far',
      'future',
      'future',
      'future',
      'future',
    ]);
  });

  it('a year is still filling until its December has had 90 days', () => {
    expect(rows.map((r) => r.filling)).toEqual([false, false, true]);
    const early = yearRows(view('2026-03-31', [cohort('2025-05')]));
    expect(early[0].filling).toBe(true);
    const later = yearRows(view('2026-04-01', [cohort('2025-05')]));
    expect(later[0].filling).toBe(false);
  });
});

describe('thirdEventFollowUp', () => {
  it('counts months from the given one whose members have all had 270 days', () => {
    // As of October 5, 2026: December 2025 is the last month with 270 days
    // behind it (December 31 + 270 is September 27).
    const followUp = thirdEventFollowUp(
      view('2026-10-05', [
        cohort('2025-09'),
        cohort('2025-10'),
        cohort('2025-12'),
        cohort('2026-01', { laterThird90: 99, laterNoThird90: 99 }),
      ]),
      '2025-10',
    );
    expect([followUp.first, followUp.last]).toEqual(['2025-10', '2025-12']);
    // Of the 4 + 4 with an early third event, 3 + 3 came back later; of the
    // other 6 + 6, 1 + 1.
    expect(followUp.early).toEqual({ count: 6, of: 8 });
    expect(followUp.notEarly).toEqual({ count: 2, of: 12 });
  });

  it('has no last month when the range starts after the last matured month', () => {
    const followUp = thirdEventFollowUp(
      view('2026-10-05', [cohort('2026-03')]),
      '2026-02',
    );
    expect(followUp.last).toBeUndefined();
    expect(followUp.early).toEqual({ count: 0, of: 0 });
  });
});

describe('createRetentionLoader', () => {
  const run = (id: number, finishedAt: string): SnapshotRun => ({
    id,
    trigger: 'job',
    kind: 'incremental',
    startedAt: new Date(finishedAt),
    finishedAt: new Date(finishedAt),
    listedAt: new Date(finishedAt),
    eventsListed: 0,
    eventsFetched: 0,
    rsvpsStored: 0,
    failed: 0,
    requests: 0,
    lastError: undefined,
  });

  function setup(ready = true) {
    const state = { run: run(1, '2026-10-05T16:00:00Z') };
    const aggregates = vi.fn(async (): Promise<RetentionAggregates> => ({
      cohorts: [cohort('2026-01')],
      months: [],
      years: [],
    }));
    const loader = createRetentionLoader({
      store: async () => ({ aggregates }),
      snapshot: async () => ({
        hasFinishedFull: async () => ready,
        lastFinishedRun: async () => state.run,
      }),
      now: () => new Date('2027-01-01T00:00:00Z'),
    });
    return { state, aggregates, loader };
  }

  it('is not ready, and reads nothing, before the first full snapshot', async () => {
    const { aggregates, loader } = setup(false);
    expect(await loader.load()).toEqual({ ready: false });
    expect(aggregates).not.toHaveBeenCalled();
  });

  it("the as-of day is the run's Pacific day, not the clock's", async () => {
    const { state, loader } = setup();
    // 05:00 UTC on Oct 6 is still Oct 5 in Seattle.
    state.run = run(1, '2026-10-06T05:00:00Z');
    const data = await loader.load();
    expect(data).toMatchObject({
      ready: true,
      asOf: '2026-10-05',
      updatedAt: new Date('2026-10-06T05:00:00Z'),
    });
  });

  it('computes once per snapshot run, and again for the next run', async () => {
    const { state, aggregates, loader } = setup();
    await loader.load();
    await loader.load();
    expect(aggregates).toHaveBeenCalledTimes(1);
    state.run = run(2, '2026-10-06T16:00:00Z');
    await loader.load();
    expect(aggregates).toHaveBeenCalledTimes(2);
    // The same run id finishing again (a resumed run) is a new key too.
    state.run = run(2, '2026-10-06T18:00:00Z');
    await loader.load();
    expect(aggregates).toHaveBeenCalledTimes(3);
  });

  it('concurrent first reads share one query', async () => {
    const { aggregates, loader } = setup();
    const [a, b, c] = await Promise.all([
      loader.load(),
      loader.load(),
      loader.load(),
    ]);
    expect(aggregates).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('a read that saw an older run never replaces or rebuilds a newer one', async () => {
    const { state, aggregates, loader } = setup();
    const newer = run(2, '2026-10-06T16:00:00Z');
    const older = run(1, '2026-10-05T16:00:00Z');
    // Cached: the newer run. A late read still sees the older run.
    state.run = newer;
    const fresh = await loader.load();
    state.run = older;
    expect(await loader.load()).toBe(fresh);
    expect(aggregates).toHaveBeenCalledTimes(1);
    // The same finish time with a lower id is older too.
    state.run = run(1, '2026-10-06T16:00:00Z');
    expect(await loader.load()).toBe(fresh);
    expect(aggregates).toHaveBeenCalledTimes(1);
  });

  it('a read that saw an older run while a newer one is building waits for the newer', async () => {
    const { state, aggregates, loader } = setup();
    let release: (value: RetentionAggregates) => void = () => undefined;
    aggregates.mockImplementationOnce(
      () =>
        new Promise<RetentionAggregates>((resolve) => {
          release = resolve;
        }),
    );
    state.run = run(2, '2026-10-06T16:00:00Z');
    const building = loader.load();
    // Let the first load reach its query before the second starts.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    state.run = run(1, '2026-10-05T16:00:00Z');
    const late = loader.load();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    release({ cohorts: [cohort('2026-02')], months: [], years: [] });
    const [a, b] = await Promise.all([building, late]);
    expect(aggregates).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(a).toMatchObject({ asOf: '2026-10-06' });
    // And the newer run is what stays cached.
    state.run = run(2, '2026-10-06T16:00:00Z');
    expect(await loader.load()).toBe(a);
    expect(aggregates).toHaveBeenCalledTimes(1);
  });

  it('a failed read is thrown and not kept: the next read tries again', async () => {
    const { aggregates, loader } = setup();
    aggregates.mockRejectedValueOnce(new Error('pool down'));
    await expect(loader.load()).rejects.toThrow('pool down');
    expect(await loader.load()).toMatchObject({ ready: true });
    expect(aggregates).toHaveBeenCalledTimes(2);
  });
});

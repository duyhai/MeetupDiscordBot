/**
 * Member retention for the staff dashboard, from the group snapshot only.
 *
 * Definitions (the page states them too):
 * - Attended: said yes (YES or ATTENDED) to a live PAST event whose title
 *   does not say "cancelled": Wrapped's rule (countsAsAttended). Meetup's
 *   no-show marks are not in the snapshot, so a yes to a past event counts.
 * - A member's events are ordered by start time. Their cohort is the
 *   Pacific month (or year) of the first one. Someone who joined and never
 *   attended is not here at all.
 * - "Within 90 days": on or before the 90th Pacific calendar day after the
 *   first event's day.
 * - As of: the Pacific day the latest snapshot run finished, not the wall
 *   clock, so the numbers are a pure function of the snapshot run.
 * - Matured: a first-event month counts toward an N-day rate only once its
 *   last day is more than N days before the as-of day, so every member in
 *   it has had the full N days.
 *
 * The SQL (PostgresRetentionRepository) returns at most a few hundred
 * aggregate rows; this module only adds those up, and caches the result per
 * snapshot run (the page runs in the bot's process).
 */
import { pacificDayOf } from '../leaderboard/standings.js';
import type { SnapshotRun } from '../repositories/postgresSnapshotRepository.js';

/** One first-event month (Pacific). Counts of members throughout. */
export interface CohortMonth {
  /** YYYY-MM. */
  month: string;
  /** Members whose first attended event was in this month. */
  members: number;
  /** Of them: attended a second / third event within 90 days of the first. */
  second90: number;
  third90: number;
  /** Of them: attended an event 271 to 365 days after the first. */
  yearOn: number;
  /** Of them: attended at least 2, 3, 4, 5, 6, 7 events (ever). */
  reached2: number;
  reached3: number;
  reached4: number;
  reached5: number;
  reached6: number;
  reached7: number;
  /**
   * Of them: attended an event 91 to 270 days after the first, split by
   * whether their third event came within 90 days of the first or not.
   */
  laterThird90: number;
  laterNoThird90: number;
}

/** One month with attendance. */
export interface ActivityMonth {
  month: string;
  /** Distinct members who attended that month. */
  active: number;
  /** Of them: their first event was that month. */
  firstTimers: number;
}

/** Members first seen in `cohort` (a year) who attended in `year`. */
export interface YearCell {
  cohort: number;
  year: number;
  members: number;
}

export interface RetentionAggregates {
  cohorts: CohortMonth[];
  months: ActivityMonth[];
  years: YearCell[];
}

export interface RetentionView extends RetentionAggregates {
  ready: true;
  /** When the latest snapshot run finished. */
  updatedAt: Date | undefined;
  /** The Pacific day of `updatedAt`: YYYY-MM-DD. */
  asOf: string;
}

export type RetentionData = { ready: false } | RetentionView;

/** The 90-day rates' window, and the one-year rate's. */
export const NINETY_DAYS = 90;
/** The follow-up window after the first 90 days ends on this day. */
export const FOLLOW_UP_DAYS = 270;
export const ONE_YEAR_DAYS = 365;
/** Months in a headline window. */
export const WINDOW_MONTHS = 12;

const DAY_MS = 86_400_000;
const MONTH = /^(\d{4})-(\d{2})$/;

const count = (value: unknown): number =>
  Math.max(0, Math.trunc(Number(value)) || 0);

/** `month` (YYYY-MM) moved by `n` months. */
export function addMonths(month: string, n: number): string {
  const match = MONTH.exec(month);
  const index = match ? Number(match[1]) * 12 + Number(match[2]) - 1 + n : 0;
  const year = Math.floor(index / 12);
  return `${String(year).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Every month from `first` to `last`, oldest first; none when last < first. */
export function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  // The cap is a backstop: the group's history is under 200 months.
  for (let m = first; m <= last && out.length < 1200; m = addMonths(m, 1)) {
    out.push(m);
  }
  return out;
}

/**
 * Whether every member whose first event was in `month` has had `days` full
 * days since: the month's last day + `days` is before `asOf`.
 */
export function isMatured(month: string, asOf: string, days: number): boolean {
  const match = MONTH.exec(month);
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  if (!match || Number.isNaN(asOfMs)) {
    return false;
  }
  // Date.UTC's month is 0-based, so this is the first day of the next month.
  const nextFirst = Date.UTC(Number(match[1]), Number(match[2]), 1);
  return nextFirst + days * DAY_MS <= asOfMs;
}

/** The latest month matured for `days`. */
export function lastMatured(asOf: string, days: number): string {
  let month = asOf.slice(0, 7);
  for (let i = 0; i < 1200 && !isMatured(month, asOf, days); i += 1) {
    month = addMonths(month, -1);
  }
  return month;
}

export interface Rate {
  count: number;
  of: number;
}

/** A whole percentage; undefined with nobody to count. */
export function percent(rate: Rate): number | undefined {
  return rate.of > 0 ? Math.round((100 * rate.count) / rate.of) : undefined;
}

type CohortSums = Omit<CohortMonth, 'month'>;
const FIELDS: readonly (keyof CohortSums)[] = [
  'members',
  'second90',
  'third90',
  'yearOn',
  'reached2',
  'reached3',
  'reached4',
  'reached5',
  'reached6',
  'reached7',
  'laterThird90',
  'laterNoThird90',
];

/** The cohort months in [first, last], added up. */
export function sumCohorts(
  cohorts: readonly CohortMonth[],
  first: string,
  last: string,
): CohortSums {
  const sums = Object.fromEntries(FIELDS.map((f) => [f, 0])) as CohortSums;
  cohorts.forEach((c) => {
    if (c.month >= first && c.month <= last) {
      FIELDS.forEach((f) => {
        sums[f] += count(c[f]);
      });
    }
  });
  return sums;
}

export interface HeadlineTile {
  /**
   * The window's first and last first-event month: the latest 12 matured
   * months, or fewer when the data starts inside the window (`months` says
   * how many).
   */
  first: string;
  last: string;
  months: number;
  rate: Rate;
  /** The up to 12 months before the window; `previousMonths` 0 with none. */
  previousFirst: string;
  previousLast: string;
  previousMonths: number;
  previous: Rate;
}

/** [first, last] cut to start no earlier than `earliest`, and its length in months. */
function covered(
  first: string,
  last: string,
  earliest: string | undefined,
): { first: string; months: number } {
  if (earliest === undefined || earliest > last) {
    return { first, months: 0 };
  }
  const from = earliest > first ? earliest : first;
  return { first: from, months: monthsBetween(from, last).length };
}

function tile(
  view: RetentionAggregates & { asOf: string },
  days: number,
  field: 'second90' | 'third90' | 'yearOn',
): HeadlineTile {
  const earliest = view.cohorts.map((c) => c.month).sort()[0];
  const last = lastMatured(view.asOf, days);
  const windowFirst = addMonths(last, 1 - WINDOW_MONTHS);
  const previousLast = addMonths(windowFirst, -1);
  const now = covered(windowFirst, last, earliest);
  const before = covered(
    addMonths(previousLast, 1 - WINDOW_MONTHS),
    previousLast,
    earliest,
  );
  const sums = sumCohorts(view.cohorts, now.first, last);
  const earlier = sumCohorts(view.cohorts, before.first, previousLast);
  return {
    first: now.first,
    last,
    months: now.months,
    rate: { count: sums[field], of: sums.members },
    previousFirst: before.first,
    previousLast,
    previousMonths: before.months,
    previous: { count: earlier[field], of: earlier.members },
  };
}

/**
 * The headline rates, each over the latest 12 first-event months that have
 * fully matured for it, with the 12 months before.
 */
export function headlines(view: RetentionAggregates & { asOf: string }): {
  third90: HeadlineTile;
  second90: HeadlineTile;
  yearOn: HeadlineTile;
} {
  return {
    third90: tile(view, NINETY_DAYS, 'third90'),
    second90: tile(view, NINETY_DAYS, 'second90'),
    yearOn: tile(view, ONE_YEAR_DAYS, 'yearOn'),
  };
}

export interface LadderStep {
  /** '1' to '6'. */
  events: string;
  /** Members who attended that many events, and those who attended another. */
  rate: Rate;
}

/** Of members who attended N events, those who attended N + 1. */
export function ladder(sums: CohortSums): LadderStep[] {
  return [
    { events: '1', rate: { count: sums.reached2, of: sums.members } },
    { events: '2', rate: { count: sums.reached3, of: sums.reached2 } },
    { events: '3', rate: { count: sums.reached4, of: sums.reached3 } },
    { events: '4', rate: { count: sums.reached5, of: sums.reached4 } },
    { events: '5', rate: { count: sums.reached6, of: sums.reached5 } },
    { events: '6', rate: { count: sums.reached7, of: sums.reached6 } },
  ];
}

/** How a following-year cell stands: complete, still in progress, or not begun. */
export type YearState = 'final' | 'so-far' | 'future';

export interface YearRow {
  year: number;
  members: number;
  /** The year's first-event months have not all had 90 days yet. */
  filling: boolean;
  oneOnly: Rate;
  fiveOrMore: Rate;
  /** First to second, second to third, third to fourth event. */
  steps: [Rate, Rate, Rate];
  /** Active 1, 2, … FOLLOWING_YEARS calendar years later. */
  following: { state: YearState; rate: Rate }[];
}

export const FOLLOWING_YEARS = 5;

/** One row per first-event year, oldest first. */
export function yearRows(
  view: RetentionAggregates & { asOf: string },
): YearRow[] {
  const asOfYear = Number(view.asOf.slice(0, 4));
  const cells = new Map<string, number>();
  view.years.forEach((cell) => {
    cells.set(`${cell.cohort}:${cell.year}`, count(cell.members));
  });
  const years = [
    ...new Set(view.cohorts.map((c) => Number(c.month.slice(0, 4)))),
  ]
    .filter((y) => Number.isInteger(y))
    .sort((a, b) => a - b);
  return years.map((year) => {
    const sums = sumCohorts(view.cohorts, `${year}-01`, `${year}-12`);
    const of = sums.members;
    return {
      year,
      members: of,
      filling: !isMatured(`${year}-12`, view.asOf, NINETY_DAYS),
      oneOnly: { count: Math.max(0, of - sums.reached2), of },
      fiveOrMore: { count: sums.reached5, of },
      steps: [
        { count: sums.reached2, of },
        { count: sums.reached3, of: sums.reached2 },
        { count: sums.reached4, of: sums.reached3 },
      ],
      following: Array.from({ length: FOLLOWING_YEARS }, (_unused, i) => {
        const target = year + i + 1;
        let state: YearState = 'final';
        if (target > asOfYear) {
          state = 'future';
        } else if (target === asOfYear) {
          state = 'so-far';
        }
        return {
          state,
          rate: { count: cells.get(`${year}:${target}`) ?? 0, of },
        };
      }),
    };
  });
}

/**
 * Whether an early third event goes with staying: members are split by
 * whether their third event came within 90 days of the first, and for each
 * group the share who attended an event 91 to 270 days after the first (a
 * window that starts after the split is decided, so neither group is in it
 * by definition). Counts first-event months from `from` whose members have
 * all had the full 270 days. An association, not a cause. `last` is
 * undefined when no month in the range has matured.
 */
export function thirdEventFollowUp(
  view: RetentionAggregates & { asOf: string },
  from: string,
): { first: string; last: string | undefined; early: Rate; notEarly: Rate } {
  const last = lastMatured(view.asOf, FOLLOW_UP_DAYS);
  const sums = sumCohorts(view.cohorts, from, last);
  return {
    first: from,
    last: last >= from ? last : undefined,
    early: { count: sums.laterThird90, of: sums.third90 },
    notEarly: {
      count: sums.laterNoThird90,
      of: Math.max(0, sums.members - sums.third90),
    },
  };
}

export interface RetentionDeps {
  store: () => Promise<{
    aggregates(): Promise<RetentionAggregates>;
  }>;
  snapshot: () => Promise<{
    hasFinishedFull(): Promise<boolean>;
    lastFinishedRun(): Promise<SnapshotRun | undefined>;
  }>;
  now: () => Date;
}

/**
 * A loader with its own cache: one per process. The aggregates are computed
 * once per snapshot run (keyed by run id and finish time, as the
 * leaderboard's loader) and kept until the next run; concurrent misses
 * share one query. A page view then costs the two small run reads. load()
 * throws when the database cannot be read.
 */
export function createRetentionLoader(deps: RetentionDeps): {
  load(): Promise<RetentionData>;
} {
  type Entry<T> = { key: string; order: number; id: number } & T;
  let cached: Entry<{ view: RetentionView }> | undefined;
  let building: Entry<{ promise: Promise<RetentionView> }> | undefined;
  /** Whether a run (finish time, then id) is older than the one an entry holds. */
  const olderThan = (
    order: number,
    id: number,
    entry: Entry<unknown> | undefined,
  ): boolean =>
    entry !== undefined &&
    (order < entry.order || (order === entry.order && id < entry.id));

  return {
    async load(): Promise<RetentionData> {
      const snapshot = await deps.snapshot();
      if (!(await snapshot.hasFinishedFull())) {
        return { ready: false };
      }
      const run = await snapshot.lastFinishedRun();
      const order = run?.finishedAt?.getTime() ?? 0;
      const id = run?.id ?? 0;
      const key = `${run?.id ?? ''}:${run?.finishedAt?.getTime() ?? ''}`;
      if (cached?.key === key) {
        return cached.view;
      }
      // A read that saw an older run than the one in flight or cached (two
      // requests racing a finishing run) is answered with the newer one and
      // never starts a build that could replace it.
      if (building && olderThan(order, id, building)) {
        return building.promise;
      }
      if (cached && olderThan(order, id, cached)) {
        return cached.view;
      }
      if (building?.key !== key) {
        const asOf = pacificDayOf(run?.finishedAt ?? deps.now());
        const promise = deps
          .store()
          .then((store) => store.aggregates())
          .then((aggregates): RetentionView => ({
            ready: true,
            updatedAt: run?.finishedAt,
            asOf,
            ...aggregates,
          }));
        const mine = { key, order, id, promise };
        building = mine;
        promise
          .then((view) => {
            if (building === mine) {
              cached = { key, order, id, view };
            }
          })
          .catch(() => undefined)
          .finally(() => {
            if (building === mine) {
              building = undefined;
            }
          });
      }
      return building.promise;
    },
  };
}

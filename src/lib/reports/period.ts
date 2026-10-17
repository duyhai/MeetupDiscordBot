import dayjs from 'dayjs';

// Extends dayjs with the utc and timezone plugins (side effect of the import).
import '../../util/timezone.js';

export const GROUP_TIMEZONE = 'America/Los_Angeles';

/**
 * The group's first month (founded 2013-03-13). Nothing is built or shown
 * for an earlier month; the backfill starts here by default.
 */
export const GROUP_FIRST_PERIOD: Period = { year: 2013, month: 3 };

export interface Period {
  readonly year: number;
  readonly month: number;
}

const PERIOD_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function periodKey({ year, month }: Period): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/** Only `YYYY-MM` with a real month and a year in 2000-2100; anything else (paths, "2026-1") is undefined. */
export function parsePeriodKey(value: string): Period | undefined {
  const match = PERIOD_KEY.exec(value);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  if (year < 2000 || year > 2100) {
    return undefined;
  }
  return { year, month: Number(match[2]) };
}

/** The value stored in DATE columns: the first of the month. */
export function periodDate(p: Period): string {
  return `${periodKey(p)}-01`;
}

/** Midnight on the 1st in the group's timezone. The 1st is never in a DST gap (changes happen at 02:00 on Sundays). */
export function periodStart(p: Period): Date {
  return dayjs.tz(`${periodDate(p)}T00:00:00`, GROUP_TIMEZONE).toDate();
}

export function nextPeriod(p: Period): Period {
  return p.month === 12
    ? { year: p.year + 1, month: 1 }
    : { year: p.year, month: p.month + 1 };
}

export function previousPeriod(p: Period): Period {
  return p.month === 1
    ? { year: p.year - 1, month: 12 }
    : { year: p.year, month: p.month - 1 };
}

/** Exclusive end: the next month's start. */
export function periodEnd(p: Period): Date {
  return periodStart(nextPeriod(p));
}

export function periodOf(instant: Date): Period {
  const local = dayjs(instant).tz(GROUP_TIMEZONE);
  return { year: local.year(), month: local.month() + 1 };
}

export function comparePeriods(a: Period, b: Period): number {
  return a.year - b.year || a.month - b.month;
}

export function isFinished(p: Period, now: Date): boolean {
  return now.getTime() >= periodEnd(p).getTime();
}

/** What a build counts up to: a finished month as of its end, every time it is (re)built; the open month as of now. */
export function buildAsOf(p: Period, now: Date): Date {
  return isFinished(p, now) ? periodEnd(p) : now;
}

/**
 * Suspensions count as "prior" for a finished month only when dated inside
 * or before it. suspended_at is stored as UTC midnight of a calendar day
 * (see utcDateOnly in suspensionList.ts), so the cutoff is the next month's
 * first day at 00:00 UTC, not periodEnd (07:00/08:00 UTC): a suspension
 * dated the 1st of the next month must not count.
 */
export function suspensionCutoff(p: Period): Date {
  return new Date(`${periodDate(nextPeriod(p))}T00:00:00.000Z`);
}

/** 'September 2026'. Fixed English names built from the period itself, never from "now". */
export function monthLabel(p: Period): string {
  return `${MONTH_NAMES[p.month - 1]} ${p.year}`;
}

export function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

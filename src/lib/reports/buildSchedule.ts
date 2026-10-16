import { IDENTITY_DIGEST_UTC_HOUR } from '../helpers/identity/digest.js';
import {
  Period,
  periodEnd,
  periodKey,
  periodOf,
  previousPeriod,
  utcDay,
} from './period.js';
import { REPORT_TYPES, ReportType } from './types.js';

/** No build is due before 16:00 UTC (≈ 8–9 am Pacific, same calendar day in both zones). */
export const BUILD_UTC_HOUR = 16;

/** Last UTC day of the month on which the previous month is still rebuilt daily. */
export const PREVIOUS_MONTH_LAST_DAILY_DAY = 7;

/**
 * The identity digest's hour (18:00–19:00 UTC). No build starts in it; the
 * hour is imported from digest.ts so the two cannot drift.
 */
export function isQuietHour(now: Date): boolean {
  return now.getUTCHours() === IDENTITY_DIGEST_UTC_HOUR;
}

/** Today's (UTC date) due time: 16:00 UTC. */
export function dueTimeToday(now: Date): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      BUILD_UTC_HOUR,
    ),
  );
}

export const snapshotKey = (reportType: ReportType, period: Period): string =>
  `${reportType}:${periodKey(period)}`;

export type DueItem =
  | {
      kind: 'month';
      period: Period;
      reason: 'previous-daily' | 'previous-catch-up' | 'current';
    }
  | { kind: 'link-progress'; day: string };

export interface DuePlanInput {
  now: Date;
  /** builtAt of the CURRENT snapshot, keyed by snapshotKey; absent when none. */
  builtAt: ReadonlyMap<string, Date>;
  linkProgressWrittenToday: boolean;
}

/**
 * What is due now, in order: previous month, current month, link progress.
 *
 * - Nothing in the quiet hour or before 16:00 UTC.
 * - Current month (Pacific): either type missing or built before today's
 *   16:00 UTC, so once per UTC day.
 * - Previous month: never on the 1st (a day of grace for late attendance).
 *   On days 2–7 it is rebuilt daily like the current month; on any later day
 *   it catches up when either type has no build made after the month ended
 *   (bot down on the 2nd–7th, or first deploy mid-month).
 * - Link progress: no row for today's UTC date.
 */
export function planDueWork({
  now,
  builtAt,
  linkProgressWrittenToday,
}: DuePlanInput): DueItem[] {
  if (isQuietHour(now) || now.getUTCHours() < BUILD_UTC_HOUR) {
    return [];
  }
  const due = dueTimeToday(now);
  const current = periodOf(now);
  const previous = previousPeriod(current);
  // True when either report type of the month is missing or older than `time`.
  const anyBuiltBefore = (period: Period, time: Date) =>
    REPORT_TYPES.some((type) => {
      const at = builtAt.get(snapshotKey(type, period));
      return at === undefined || at.getTime() < time.getTime();
    });

  const items: DueItem[] = [];
  const day = now.getUTCDate();
  if (day >= 2) {
    if (day <= PREVIOUS_MONTH_LAST_DAILY_DAY && anyBuiltBefore(previous, due)) {
      items.push({ kind: 'month', period: previous, reason: 'previous-daily' });
    } else if (anyBuiltBefore(previous, periodEnd(previous))) {
      items.push({
        kind: 'month',
        period: previous,
        reason: 'previous-catch-up',
      });
    }
  }
  if (anyBuiltBefore(current, due)) {
    items.push({ kind: 'month', period: current, reason: 'current' });
  }
  if (!linkProgressWrittenToday) {
    items.push({ kind: 'link-progress', day: utcDay(now) });
  }
  return items;
}

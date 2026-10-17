import {
  IDENTITY_DIGEST_UTC_HOUR,
  shouldRunIdentityDigestNow,
} from '../helpers/identity/digest.js';
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
 * The identity digest's hour (18:00–19:00 UTC). No build starts in it; it
 * delegates to the digest's own schedule check so the two cannot drift.
 */
export function isQuietHour(now: Date): boolean {
  return shouldRunIdentityDigestNow(now);
}

/** Month builds stop STARTING this many minutes before the identity sweep. */
export const SWEEP_LEAD_MINUTES = 15;

/**
 * Whether a month build may start now (job or manual): never from 17:45 UTC
 * (too close to the 18:00 identity sweep, which makes a full-guild member
 * pass on an R14-prone dyno) until 19:00 UTC. The job's own 16:00 start is
 * planDueWork's business, not this rule's.
 */
export function canStartMonthBuild(now: Date): boolean {
  if (isQuietHour(now)) {
    return false;
  }
  return !(
    now.getUTCHours() === IDENTITY_DIGEST_UTC_HOUR - 1 &&
    now.getUTCMinutes() >= 60 - SWEEP_LEAD_MINUTES
  );
}

/**
 * Whether link progress (a full-guild member pass) may start now: in the
 * build window under the same sweep rule as a month, i.e. 16:00–17:45 and
 * 19:00–24:00 UTC. It must not overlap the 18:00 identity sweep's own
 * full-guild member pass; digest.ts explains why each pass gets its own time.
 */
export function canStartLinkProgress(now: Date): boolean {
  return now.getUTCHours() >= BUILD_UTC_HOUR && canStartMonthBuild(now);
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
 * - Link progress: no row for today's UTC date, and only when
 *   canStartLinkProgress.
 * - Neither a month nor link progress from 17:45 UTC (canStartMonthBuild).
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
  const monthsMayStart = canStartMonthBuild(now);
  if (monthsMayStart && day >= 2) {
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
  if (monthsMayStart && anyBuiltBefore(current, due)) {
    items.push({ kind: 'month', period: current, reason: 'current' });
  }
  if (!linkProgressWrittenToday && canStartLinkProgress(now)) {
    items.push({ kind: 'link-progress', day: utcDay(now) });
  }
  return items;
}

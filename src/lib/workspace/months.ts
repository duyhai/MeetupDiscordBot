import {
  comparePeriods,
  nextPeriod,
  Period,
  periodDate,
  periodOf,
  previousPeriod,
  suspensionCutoff,
} from '../reports/period.js';

/**
 * The first month with a workspace: the latest finished month when PR 4
 * shipped. Older months stay read-only history.
 */
export const WORKSPACE_FIRST_PERIOD: Period = { year: 2026, month: 9 };
const MAX_MONTHS = 240;

/** WORKSPACE_FIRST_PERIOD through the current Pacific month, the open month included. */
export function isWorkspaceMonth(p: Period | undefined, now: Date): boolean {
  return (
    Number.isInteger(p?.year) &&
    Number.isInteger(p?.month) &&
    p.month >= 1 &&
    p.month <= 12 &&
    comparePeriods(p, WORKSPACE_FIRST_PERIOD) >= 0 &&
    comparePeriods(p, periodOf(now)) <= 0
  );
}

/**
 * The suspension dates a case's card may link (lead review, 2026-10-17): from
 * the case month's 1st through the last day of the month after it, in the
 * stored convention (UTC midnights): `from` included, `until` (the 1st of
 * the month after next) excluded. A September case is usually suspended in
 * October, often with /meetup_record_suspension, and its card must be able
 * to link that record. The action's SQL and the month page both use it, so
 * the page offers only what the POST takes.
 */
export function linkWindow(p: Period): { from: Date; until: Date } {
  return {
    from: new Date(`${periodDate(p)}T00:00:00.000Z`),
    until: suspensionCutoff(nextPeriod(p)),
  };
}

/** Newest first: the current Pacific month back to WORKSPACE_FIRST_PERIOD. */
export function workspaceMonths(now: Date): Period[] {
  const months: Period[] = [];
  for (
    let p = periodOf(now);
    comparePeriods(p, WORKSPACE_FIRST_PERIOD) >= 0 &&
    months.length < MAX_MONTHS;
    p = previousPeriod(p)
  ) {
    months.push(p);
  }
  return months;
}

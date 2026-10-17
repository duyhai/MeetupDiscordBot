import { PUBLIC_APP_ORIGIN } from '../../constants.js';
import {
  comparePeriods,
  GROUP_FIRST_PERIOD,
  Period,
  parsePeriodKey,
  periodKey,
} from './period.js';

/**
 * Every dashboard page path, shared by the route registrations (src/web) and
 * the build alerts (buildJob.ts), so a renamed route cannot leave the alert
 * links pointing at nothing. Lives under src/lib because buildJob must not
 * import from src/web.
 */
export const DASHBOARD_BASE = '/dashboard';
export const DASHBOARD_PATHS = {
  hallOfFame: '/hall-of-fame',
  hallOfFameMonth: '/hall-of-fame/:period',
  noShowHistory: '/no-show-history',
  noShowHistoryMonth: '/no-show-history/:period',
  noShowHistoryMember: '/no-show-history/members/:memberId',
  suspensions: '/suspensions',
  identity: '/identity',
  identityThumb: '/identity/changes/:id/thumb/:side',
  linkProgress: '/link-progress',
  trends: '/trends',
  refresh: '/reports/:period/refresh',
} as const;

export type DashboardPathTemplate =
  (typeof DASHBOARD_PATHS)[keyof typeof DASHBOARD_PATHS];
export type MonthPathTemplate =
  | typeof DASHBOARD_PATHS.hallOfFameMonth
  | typeof DASHBOARD_PATHS.noShowHistoryMonth
  | typeof DASHBOARD_PATHS.refresh;

const MEMBER_ID = /^[0-9]{1,20}$/;

/** A real month before the group's first (GROUP_FIRST_PERIOD): no dashboard page exists for it. */
export class MonthBeforeGroupError extends RangeError {
  constructor() {
    super("monthPath needs a month from the group's first onwards");
    this.name = 'MonthBeforeGroupError';
  }
}

/**
 * '/dashboard/hall-of-fame/2026-09'. The month must survive parsePeriodKey, so
 * no other text can reach the path, and must not be before GROUP_FIRST_PERIOD
 * (the routes 404 those months). The one floor for every month link.
 */
export function monthPath(template: MonthPathTemplate, period: Period): string {
  const key = periodKey(period);
  const parsed = parsePeriodKey(key);
  if (
    parsed === undefined ||
    parsed.year !== period.year ||
    parsed.month !== period.month
  ) {
    throw new RangeError('monthPath needs a real month');
  }
  if (comparePeriods(parsed, GROUP_FIRST_PERIOD) < 0) {
    throw new MonthBeforeGroupError();
  }
  return `${DASHBOARD_BASE}${template.replace(':period', key)}`;
}

/**
 * monthPath for a stored row's month: the path, or undefined when monthPath
 * refuses it (before the group's first month, or not a real month), so one
 * bad row renders unlinked instead of taking down a whole list page.
 */
export function linkableMonthPath(
  template: MonthPathTemplate,
  period: Period,
): string | undefined {
  try {
    return monthPath(template, period);
  } catch (error) {
    if (error instanceof RangeError) {
      return undefined;
    }
    throw error;
  }
}

/** Absolute links for Discord: only PUBLIC_APP_ORIGIN and the validated month key. */
export function monthPageUrls(period: Period): {
  hallOfFame: string;
  noShowHistory: string;
} {
  return {
    hallOfFame: `${PUBLIC_APP_ORIGIN}${monthPath(DASHBOARD_PATHS.hallOfFameMonth, period)}`,
    noShowHistory: `${PUBLIC_APP_ORIGIN}${monthPath(DASHBOARD_PATHS.noShowHistoryMonth, period)}`,
  };
}

/** One member's no-show history page, only from an all-digit Meetup id (1-20 digits). */
export function memberHistoryPath(memberId: string): string | undefined {
  return typeof memberId === 'string' && MEMBER_ID.test(memberId)
    ? `${DASHBOARD_BASE}${DASHBOARD_PATHS.noShowHistoryMember.replace(':memberId', memberId)}`
    : undefined;
}

/** The path constants without a route parameter. */
export type ParamFreeDashboardPath = Exclude<
  DashboardPathTemplate,
  `${string}:${string}`
>;

/** '/dashboard' plus a param-free path constant. The type refuses a template with a parameter; so does the runtime check. */
export function dashboardPath(path: ParamFreeDashboardPath): string {
  if (path.includes(':')) {
    throw new RangeError('dashboardPath takes a path without parameters');
  }
  return `${DASHBOARD_BASE}${path}`;
}

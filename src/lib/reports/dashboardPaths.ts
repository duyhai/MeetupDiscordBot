import { PUBLIC_APP_ORIGIN } from '../../constants.js';
import { WORKSPACE_FIRST_PERIOD } from '../workspace/months.js';
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
  sessions: '/sessions',
  revokeSessions: '/sessions/revoke',
  workspace: '/no-shows',
  workspaceMonth: '/no-shows/:period',
  workspaceRow: '/no-shows/:period/rows/:rowId',
  workspaceSuspend: '/no-shows/:period/rows/:rowId/suspend',
  workspaceSync: '/no-shows/:period/sync',
} as const;

export type DashboardPathTemplate =
  (typeof DASHBOARD_PATHS)[keyof typeof DASHBOARD_PATHS];
export type MonthPathTemplate =
  | typeof DASHBOARD_PATHS.hallOfFameMonth
  | typeof DASHBOARD_PATHS.noShowHistoryMonth
  | typeof DASHBOARD_PATHS.refresh
  | typeof DASHBOARD_PATHS.workspaceMonth
  | typeof DASHBOARD_PATHS.workspaceSync;

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

const MAX_ROW_ID = 2 ** 31 - 1;

/**
 * '/dashboard/no-shows/2026-09/rows/12' (or '.../12/suspend'): monthPath's
 * checks plus a row id from 1 to 2^31-1 (a Postgres SERIAL). Throws
 * RangeError. The routes add the workspace range (parseWorkspaceMonth).
 */
export function workspaceRowPath(
  period: Period,
  rowId: number,
  suffix?: 'suspend',
): string {
  const month = monthPath(DASHBOARD_PATHS.workspaceMonth, period);
  if (!Number.isSafeInteger(rowId) || rowId < 1 || rowId > MAX_ROW_ID) {
    throw new RangeError('workspaceRowPath needs a row id from 1 to 2^31-1');
  }
  return `${month}/rows/${rowId}${suffix === 'suspend' ? '/suspend' : ''}`;
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

/** A month's dashboard links for Discord; `workspace` only for workspace months. */
export interface MonthPageUrls {
  hallOfFame: string;
  noShowHistory: string;
  workspace?: string;
}

/**
 * Absolute links for Discord: only PUBLIC_APP_ORIGIN and the validated month
 * key. `workspace` is present only for months that have a workspace (from
 * WORKSPACE_FIRST_PERIOD on); older months link their no-show history only.
 * No "up to the current month" check: there is no clock here, and builds
 * exist only for months up to the current one.
 */
export function monthPageUrls(period: Period): MonthPageUrls {
  const urls: MonthPageUrls = {
    hallOfFame: `${PUBLIC_APP_ORIGIN}${monthPath(DASHBOARD_PATHS.hallOfFameMonth, period)}`,
    noShowHistory: `${PUBLIC_APP_ORIGIN}${monthPath(DASHBOARD_PATHS.noShowHistoryMonth, period)}`,
  };
  if (comparePeriods(period, WORKSPACE_FIRST_PERIOD) >= 0) {
    urls.workspace = `${PUBLIC_APP_ORIGIN}${monthPath(DASHBOARD_PATHS.workspaceMonth, period)}`;
  }
  return urls;
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

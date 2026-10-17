import dayjs from 'dayjs';
import { Response } from 'express';
import { Logger } from 'tslog';

import {
  DASHBOARD_BASE,
  DASHBOARD_PATHS,
  MonthPathTemplate,
  dashboardPath,
  linkableMonthPath,
} from '../lib/reports/dashboardPaths.js';
import { noShowsMissing } from '../lib/reports/meetupMonth.js';
import {
  GROUP_FIRST_PERIOD,
  Period,
  comparePeriods,
  isFinished,
  monthLabel,
  parsePeriodKey,
  periodOf,
} from '../lib/reports/period.js';
import { AttendanceEvidence } from '../lib/reports/types.js';
import { isWorkspaceMonth } from '../lib/workspace/months.js';
import { tz } from '../util/timezone.js';
import { dashboardLocals } from './dashboardRouter.js';
import { SafeHtml, html, localUrl, staticRaw } from './html.js';
import { discordProfileUrl, discordUserLink } from './links.js';
import { errorPage, layout } from './pages.js';

const logger = new Logger({ name: 'dashboard' });

const NAV = html`<nav class="site">
  <a href="${localUrl(DASHBOARD_BASE)}">Home</a>
  <a href="${localUrl(dashboardPath(DASHBOARD_PATHS.hallOfFame))}"
    >Hall of Fame</a
  >
  <a href="${localUrl(dashboardPath(DASHBOARD_PATHS.noShowHistory))}"
    >No-show history</a
  >
  <a href="${localUrl(dashboardPath(DASHBOARD_PATHS.suspensions))}"
    >Suspensions</a
  >
  <a href="${localUrl(dashboardPath(DASHBOARD_PATHS.identity))}"
    >Identity changes</a
  >
  <a href="${localUrl(dashboardPath(DASHBOARD_PATHS.linkProgress))}"
    >Link progress</a
  >
  <a href="${localUrl(dashboardPath(DASHBOARD_PATHS.trends))}">Trends</a>
  <a href="${localUrl(dashboardPath(DASHBOARD_PATHS.sessions))}">Sessions</a>
</nav>`;

/** Fixed text: copies the value of the textarea named by data-copy. Never carries data. */
// eslint-disable-next-line @stylistic/max-len -- one line, so the script text is exactly what runs
export const COPY_SCRIPT = staticRaw`document.querySelectorAll('button[data-copy]').forEach(function(b){b.addEventListener('click',function(){var t=document.getElementById(b.getAttribute('data-copy'));if(!t){return;}t.select();if(!navigator.clipboard){b.textContent='Select the text and copy it';return;}navigator.clipboard.writeText(t.value).then(function(){b.textContent='Copied';},function(){b.textContent='Select the text and copy it';});});});`;

export function dashboardPage(
  res: Response,
  page: { title: string; body: SafeHtml; status?: number; script?: boolean },
): void {
  const { session, nonce } = dashboardLocals(res);
  // prettier-ignore
  const script = page.script ? html`<script nonce="${nonce}">${COPY_SCRIPT}</script>` : '';
  res
    .status(page.status ?? 200)
    .type('html')
    .send(
      layout({
        title: page.title,
        nonce,
        user: session,
        body: html`${NAV}${page.body}${script}`,
      }),
    );
}

export function notFound(res: Response): void {
  res
    .status(404)
    .type('html')
    .send(errorPage(404, dashboardLocals(res).nonce));
}

/** A data outage: errorPage's 503 text is about the access check, so this has its own page. */
export function unavailable(res: Response, what: string): void {
  dashboardPage(res, {
    title: 'Unavailable',
    status: 503,
    body: html`<div class="card">
      <h1>Unavailable</h1>
      <p>
        ${what} cannot be loaded right now. Please try again in a few minutes.
      </p>
    </div>`,
  });
}

/**
 * How long a page's data read may take before the 503 page renders. A
 * blackholed Postgres would otherwise hold the request in pool.connect past
 * Heroku's 30 s router timeout (H12). The pools' own connectionTimeoutMillis
 * stays as it is: they are shared with the identity sweep and the commands.
 */
export const PAGE_LOAD_DEADLINE_MS = 10_000;

class PageLoadTimeoutError extends Error {
  constructor() {
    super(`page read took over ${PAGE_LOAD_DEADLINE_MS} ms`);
    this.name = 'PageLoadTimeoutError';
  }
}

/**
 * Runs a data read under PAGE_LOAD_DEADLINE_MS; on failure or timeout logs
 * the error's class name only and renders nothing: for a page part that
 * has its own fixed fallback. A read still running at
 * the deadline is left to finish (or fail) unobserved.
 */
export async function loadOptional<T>(
  what: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // Promise.race subscribes to the read, so one that fails after the
    // deadline is still handled (never an unhandled rejection).
    const read = fn();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new PageLoadTimeoutError()),
        PAGE_LOAD_DEADLINE_MS,
      );
      timer.unref();
    });
    return { ok: true, value: await Promise.race([read, deadline]) };
  } catch (error) {
    logger.warn(
      `Dashboard ${what} read failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** loadOptional, rendering the 503 page on failure or timeout. */
export async function load<T>(
  res: Response,
  what: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const loaded = await loadOptional(what, fn);
  if (!loaded.ok) {
    unavailable(res, what);
  }
  return loaded;
}

/** A route's :period: parsePeriodKey only, never before the group's first month and never after the current Pacific month. */
export function parseRouteMonth(value: unknown, now: Date): Period | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const period = parsePeriodKey(value);
  if (
    period === undefined ||
    comparePeriods(period, GROUP_FIRST_PERIOD) < 0 ||
    comparePeriods(period, periodOf(now)) > 0
  ) {
    return undefined;
  }
  return period;
}

/** parseRouteMonth plus the workspace range (WORKSPACE_FIRST_PERIOD through the current Pacific month). */
export function parseWorkspaceMonth(
  value: unknown,
  now: Date,
): Period | undefined {
  const period = parseRouteMonth(value, now);
  return period !== undefined && isWorkspaceMonth(period, now)
    ? period
    : undefined;
}

/** A workspace row id route param: 1-9 digits, no leading zero (so never 0). */
export function parseRowId(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

/** 'Sep 3, 2026 7:00 PM' in the group's timezone. */
export const pacificDateTime = (value: Date | string): string =>
  pacificFormat(value, 'MMM D, YYYY h:mm A');

/** 'Sep 3, 2026' in the group's timezone. */
export const pacificDate = (value: Date | string): string =>
  pacificFormat(value, 'MMM D, YYYY');

/**
 * Only a non-empty string or a Date that parses: dayjs(undefined) is "now",
 * so a missing stored date would otherwise render as the current time.
 */
function pacificFormat(value: unknown, format: string): string {
  if (!(value instanceof Date) && (typeof value !== 'string' || value === '')) {
    return '';
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? tz(parsed).format(format) : '';
}

export function builtByHtml(builtBy: string): SafeHtml {
  if (builtBy === 'job') {
    return html`the daily job`;
  }
  if (builtBy === 'backfill') {
    return html`the backfill`;
  }
  return discordProfileUrl(builtBy)
    ? html`a staff member (${discordUserLink(builtBy, 'profile')})`
    : html`a staff member`;
}

/** Only for finished months: past events had RSVPs, nobody was marked a no-show. Never says "incomplete". */
export function zeroNoShowNote(
  period: Period,
  attendance: AttendanceEvidence | null | undefined,
  now: Date,
): SafeHtml | '' {
  if (!attendance || !isFinished(period, now) || !noShowsMissing(attendance)) {
    return '';
  }
  return html`<p class="note">
    No no-shows were recorded for ${monthLabel(period)} across
    ${attendance.pastEventsWithRsvps} past events with RSVPs. Check that
    attendance was taken.
  </p>`;
}

/** A list row's month: linked to its page, or plain text when the month has no page (see linkableMonthPath). */
export function monthCell(
  template: MonthPathTemplate,
  period: Period,
): SafeHtml {
  const path = linkableMonthPath(template, period);
  return path === undefined
    ? html`${monthLabel(period)}`
    : html`<a href="${localUrl(path)}">${monthLabel(period)}</a>`;
}

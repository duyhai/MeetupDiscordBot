import dayjs from 'dayjs';
import { Response } from 'express';
import { Logger } from 'tslog';

import {
  DASHBOARD_PATHS,
  dashboardPath,
} from '../lib/reports/dashboardPaths.js';
import { noShowsMissing } from '../lib/reports/meetupMonth.js';
import {
  Period,
  comparePeriods,
  isFinished,
  monthLabel,
  parsePeriodKey,
  periodOf,
} from '../lib/reports/period.js';
import { AttendanceEvidence } from '../lib/reports/types.js';
import { tz } from '../util/timezone.js';
import { dashboardLocals } from './dashboardRouter.js';
import { SafeHtml, html } from './html.js';
import { discordUserLink } from './links.js';
import { errorPage, layout } from './pages.js';

const logger = new Logger({ name: 'dashboard' });

const NAV = html`<nav class="site">
  <a href="/dashboard">Home</a>
  <a href="${dashboardPath(DASHBOARD_PATHS.hallOfFame)}">Hall of Fame</a>
  <a href="${dashboardPath(DASHBOARD_PATHS.noShowHistory)}">No-show history</a>
  <a href="${dashboardPath(DASHBOARD_PATHS.suspensions)}">Suspensions</a>
  <a href="${dashboardPath(DASHBOARD_PATHS.identity)}">Identity changes</a>
  <a href="${dashboardPath(DASHBOARD_PATHS.linkProgress)}">Link progress</a>
  <a href="${dashboardPath(DASHBOARD_PATHS.trends)}">Trends</a>
</nav>`;

/** Fixed text: copies the value of the textarea named by data-copy. Never carries data. */
export const COPY_SCRIPT =
  "document.querySelectorAll('button[data-copy]').forEach(function(b){" +
  "b.addEventListener('click',function(){var t=document.getElementById(b.getAttribute('data-copy'));" +
  "if(!t){return;}t.select();navigator.clipboard.writeText(t.value).then(function(){b.textContent='Copied';}," +
  "function(){b.textContent='Select the text and copy it';});});});";

export function dashboardPage(
  res: Response,
  page: { title: string; body: SafeHtml; status?: number; script?: boolean },
): void {
  const { session, nonce } = dashboardLocals(res);
  const script = page.script
    ? html`<script nonce="${nonce}">
        ${new SafeHtml(COPY_SCRIPT)};
      </script>`
    : '';
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

/** Runs a data read; on failure logs the error's class name only and renders the 503 page. */
export async function load<T>(
  res: Response,
  what: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    logger.warn(
      `Dashboard ${what} read failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    unavailable(res, what);
    return { ok: false };
  }
}

/** A route's :period: parsePeriodKey only, and never after the current Pacific month. */
export function parseRouteMonth(value: unknown, now: Date): Period | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const period = parsePeriodKey(value);
  if (period === undefined || comparePeriods(period, periodOf(now)) > 0) {
    return undefined;
  }
  return period;
}

/** 'Sep 3, 2026 7:00 PM' in the group's timezone. */
export const pacificDateTime = (value: Date | string): string =>
  tz(dayjs(value)).format('MMM D, YYYY h:mm A');

/** 'Sep 3, 2026' in the group's timezone. */
export const pacificDate = (value: Date | string): string =>
  tz(dayjs(value)).format('MMM D, YYYY');

export function builtByHtml(builtBy: string): SafeHtml {
  if (builtBy === 'job') {
    return html`the daily job`;
  }
  if (builtBy === 'backfill') {
    return html`the backfill`;
  }
  return html`a staff member (${discordUserLink(builtBy, 'profile')})`;
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

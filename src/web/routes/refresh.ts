import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import { RebuildRefusal } from '../../lib/reports/buildJob.js';
import {
  DASHBOARD_PATHS,
  monthPath,
} from '../../lib/reports/dashboardPaths.js';
import { Period, periodKey } from '../../lib/reports/period.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html, localUrl } from '../html.js';
import { notFound, parseRouteMonth } from '../pageKit.js';
import { CacheTimeoutError } from '../timedCache.js';
import type { DashboardPageDeps } from './dashboardPages.js';

const logger = new Logger({ name: 'dashboard' });

export type RefreshCode = RebuildRefusal | 'started' | 'error' | 'unavailable';

/** Fixed text per code. Nothing from the request or from requestRebuild is ever shown. */
export const REFRESH_MESSAGES = {
  started:
    'Refreshing from Meetup. The result is posted to #meetup-bot-alerts; reload this page in a minute or two.',
  'quiet-hour':
    'Reports are not rebuilt between 17:45 and 19:00 UTC while the daily identity sweep runs. Try again after 19:00 UTC.',
  'identity-sweep':
    'The daily identity sweep is still running. Try again in a few minutes.',
  busy: 'A report build is already running. Try again when it finishes.',
  cooldown:
    'This month was refreshed in the last 10 minutes. Try again in a few minutes.',
  'future-month': 'That month has not started yet.',
  'bad-month': 'That is not a valid month.',
  'bad-requester': 'Only a signed-in staff member can refresh reports.',
  error: 'The refresh could not be started. Please try again later.',
  unavailable: 'Refreshing is unavailable right now. Please try again later.',
} as const satisfies Record<RefreshCode, string>;

export const REFRESH_CODES = Object.keys(REFRESH_MESSAGES) as RefreshCode[];

const isRefreshCode = (code: unknown): code is RefreshCode =>
  typeof code === 'string' && Object.hasOwn(REFRESH_MESSAGES, code);

/** Fixed text for a known code; anything else in the query renders nothing (never echoed). */
export function refreshNotice(code: unknown): SafeHtml | '' {
  return isRefreshCode(code)
    ? html`<p class="note">${REFRESH_MESSAGES[code]}</p>`
    : '';
}

export type RefreshReturn = 'hall-of-fame' | 'no-show-history';

export function refreshForm(
  period: Period,
  csrfToken: string,
  returnTo: RefreshReturn,
): SafeHtml {
  return html`<form
    method="post"
    action="${localUrl(monthPath(DASHBOARD_PATHS.refresh, period))}"
  >
    <input type="hidden" name="_csrf" value="${csrfToken}" />
    <input type="hidden" name="return" value="${returnTo}" />
    <button type="submit">Refresh from Meetup</button>
  </form>`;
}

/**
 * POST /dashboard/reports/:period/refresh. CSRF, Origin, Sec-Fetch-Site and
 * the per-user action rate limit are the router's unsafe-method guard, which
 * runs before this handler; nothing here adds its own.
 */
export function registerRefreshRoute(
  router: express.Router,
  deps: Pick<DashboardPageDeps, 'now' | 'rebuild'>,
): void {
  router.post(DASHBOARD_PATHS.refresh, (async (req, res) => {
    const period = parseRouteMonth(req.params.period, deps.now());
    if (period === undefined) {
      notFound(res);
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const target =
      body?.return === 'no-show-history'
        ? DASHBOARD_PATHS.noShowHistoryMonth
        : DASHBOARD_PATHS.hallOfFameMonth;
    const { session } = dashboardLocals(res);
    let code: RefreshCode;
    try {
      const result = await deps.rebuild(period, session.userId);
      code = isRefreshCode(result.status) ? result.status : 'error';
      if (result.status === 'started') {
        const key = periodKey(period);
        // done never rejects (buildJob's contract); the catch is belt and braces.
        result.done
          .then((outcome) =>
            logger.info(
              `Dashboard refresh of ${key} finished: ${outcome.ok ? 'saved' : 'failed'}`,
            ),
          )
          .catch(() => undefined);
      }
    } catch (error: unknown) {
      if (error instanceof CacheTimeoutError) {
        // Redis is not answering: the router's 503, like every other
        // dashboard request.
        throw error;
      }
      // requestRebuild rejects when the cache or lease read fails before it
      // can answer.
      logger.warn(
        `Dashboard refresh could not start: ${error instanceof Error ? error.name : 'Error'}`,
      );
      code = 'error';
    }
    res.redirect(303, `${monthPath(target, period)}?refresh=${code}`);
  }) as RequestHandler);
}

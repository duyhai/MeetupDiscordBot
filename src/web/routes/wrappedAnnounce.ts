import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import { LogEntry } from '../../lib/helpers/discordLogger.js';
import {
  DASHBOARD_PATHS,
  dashboardPath,
} from '../../lib/reports/dashboardPaths.js';
import { WrappedAnnounceOutcome } from '../../lib/wrapped/announce.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html } from '../html.js';
import type { DashboardPageDeps } from './dashboardPages.js';

const logger = new Logger({ name: 'dashboard' });

export const WRAPPED_ANNOUNCE_PATH = dashboardPath(
  DASHBOARD_PATHS.wrappedAnnounce,
);

export type WrappedNoticeCode =
  WrappedAnnounceOutcome | 'not-leadership' | 'unavailable' | 'error';

/** Fixed text per code. Nothing from the request, the store or Discord is ever shown. */
export const WRAPPED_NOTICES = {
  posted: 'The Wrapped announcement was posted.',
  'already-posted':
    'The Wrapped announcement for this year was already posted; nothing was sent.',
  'in-progress':
    'Another process is posting the Wrapped announcement right now; reload in a minute.',
  'backing-off':
    'The last post failed and the job is waiting before it retries; Post now did not get past that, reload and try again.',
  failed:
    'The post did not land. Nothing is recorded, so the job (or Post now) will try again.',
  disabled:
    'WRAPPED_ANNOUNCE_CHANNEL_ID is not set, so there is nowhere to post.',
  'not-due': 'The announcement is not due yet.',
  'not-leadership':
    'Only the 1.5 Leadership Team can post the Wrapped announcement.',
  unavailable:
    'Discord could not be reached to check your role. Nothing was posted; try again in a minute.',
  error: 'The announcement could not be posted. Please try again later.',
} as const satisfies Record<WrappedNoticeCode, string>;

const isNoticeCode = (code: unknown): code is WrappedNoticeCode =>
  typeof code === 'string' && Object.hasOwn(WRAPPED_NOTICES, code);

/** Fixed text for a known code; anything else in the query renders nothing (never echoed). */
export function wrappedNotice(code: unknown): SafeHtml | '' {
  if (!isNoticeCode(code)) {
    return '';
  }
  return code === 'posted' || code === 'already-posted'
    ? html`<p class="note info">${WRAPPED_NOTICES[code]}</p>`
    : html`<p class="note attn">${WRAPPED_NOTICES[code]}</p>`;
}

const back = (code: WrappedNoticeCode) => `/dashboard?wrapped=${code}`;

/**
 * POST /dashboard/wrapped/announce: posts the "your Wrapped is ready" notice
 * now if this year's has not gone out (the same claim the job uses, so the
 * two can never both post). 1.5 Leadership Team only, asked of Discord live.
 * CSRF, Origin, Sec-Fetch-Site and the per-user action rate limit are the
 * router's unsafe-method guard, which runs before this handler.
 */
export function registerWrappedAnnounceRoute(
  router: express.Router,
  deps: Pick<DashboardPageDeps, 'isLeadership' | 'audit' | 'wrappedAnnounce'>,
): void {
  // Fire-and-forget like the other audits: a slow or failing post never
  // holds up or undoes the action.
  const audit = (entry: LogEntry) => {
    Promise.resolve()
      .then(() => deps.audit(entry))
      .catch((error: unknown) =>
        logger.warn(
          `Dashboard audit post failed: ${error instanceof Error ? error.name : 'Error'}`,
        ),
      );
  };

  router.post(DASHBOARD_PATHS.wrappedAnnounce, (async (_req, res) => {
    const { session } = dashboardLocals(res);
    let leader: boolean;
    try {
      leader = await deps.isLeadership(session.userId);
    } catch (error: unknown) {
      logger.warn(
        `Dashboard Leadership check failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      res.redirect(303, back('unavailable'));
      return;
    }
    if (leader !== true) {
      res.redirect(303, back('not-leadership'));
      return;
    }
    let outcome: WrappedAnnounceOutcome;
    try {
      outcome = await deps.wrappedAnnounce.postNow();
    } catch (error: unknown) {
      logger.warn(
        `Wrapped Post now failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      res.redirect(303, back('error'));
      return;
    }
    if (outcome === 'posted') {
      audit({
        title: 'Wrapped announcement posted',
        description: `<@${session.userId}> posted the Wrapped announcement from the staff dashboard.`,
      });
    }
    res.redirect(303, back(outcome));
  }) as RequestHandler);
}

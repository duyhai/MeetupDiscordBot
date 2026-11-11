/**
 * The staff dashboard's "Wrapped backfill" card (last run, the open run's
 * progress, the queue, the next tick) and its leadership-only Run now, which
 * asks the next tick to start a run. Reads only summaries; nothing from the
 * store, the request or Discord is echoed.
 */
import dayjs from 'dayjs';
import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import { LogEntry } from '../../lib/helpers/discordLogger.js';
import {
  DASHBOARD_PATHS,
  dashboardPath,
} from '../../lib/reports/dashboardPaths.js';
import { BackfillRun } from '../../lib/repositories/postgresWrappedBackfillRepository.js';
import { RUN_INTERVAL_MS } from '../../lib/wrapped/backfill.js';
import { tz } from '../../util/timezone.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html, localUrl } from '../html.js';
import { pacificDateTime } from '../pageKit.js';
import type { DashboardPageDeps } from './dashboardPages.js';

const logger = new Logger({ name: 'dashboard' });

export const WRAPPED_BACKFILL_PATH = dashboardPath(
  DASHBOARD_PATHS.wrappedBackfill,
);

export interface BackfillStatus {
  lastRun: BackfillRun | undefined;
  openRun: BackfillRun | undefined;
  queueLength: number;
  /** The scheduler's recorded next tick; undefined when it is not running. */
  nextTickAt: Date | undefined;
  /** Rows in wrapped_entries. */
  entries: number;
}

export type RunNowOutcome =
  'requested' | 'already-running' | 'already-requested';

/** What the card reads and Run now does; production wires the repository and the cache. */
export interface WrappedBackfillControl {
  status(): Promise<BackfillStatus>;
  runNow(requestedBy: string): Promise<RunNowOutcome>;
}

export type BackfillNoticeCode =
  RunNowOutcome | 'not-leadership' | 'unavailable' | 'error';

/** Fixed text per code. Nothing from the request, the store or Discord is ever shown. */
export const BACKFILL_NOTICES = {
  requested:
    'The Wrapped backfill will start on its next tick (within 5 minutes).',
  'already-running': 'A Wrapped backfill run is already in progress.',
  'already-requested': 'Run now was already pressed; the next tick starts it.',
  'not-leadership':
    'Only the 1.5 Leadership Team can run the Wrapped backfill.',
  unavailable:
    'Discord could not be reached to check your role. Nothing was requested; try again in a minute.',
  error: 'The backfill could not be requested. Please try again later.',
} as const satisfies Record<BackfillNoticeCode, string>;

const isNoticeCode = (code: unknown): code is BackfillNoticeCode =>
  typeof code === 'string' && Object.hasOwn(BACKFILL_NOTICES, code);

/** Fixed text for a known code; anything else in the query renders nothing (never echoed). */
export function backfillNotice(code: unknown): SafeHtml | '' {
  if (!isNoticeCode(code)) {
    return '';
  }
  return code === 'requested'
    ? html`<p class="note info">${BACKFILL_NOTICES[code]}</p>`
    : html`<p class="note attn">${BACKFILL_NOTICES[code]}</p>`;
}

const pacificTime = (at: Date) => tz(dayjs(at)).format('h:mm A');

const counts = (run: BackfillRun) =>
  `built ${run.built}, skipped ${run.skipped}, failed ${run.failed}`;

/** The card's body from a status; the card wrapper and the deadline are home.ts's. */
export async function wrappedBackfillCard(
  deps: Pick<DashboardPageDeps, 'wrappedBackfill'>,
  view: { csrfToken?: string; backfillNotice?: unknown },
): Promise<SafeHtml> {
  const status = await deps.wrappedBackfill.status();
  const { lastRun, openRun } = status;
  const last = lastRun?.finishedAt
    ? html`<p>
        Last run finished ${pacificDateTime(lastRun.finishedAt)} Pacific:
        ${String(lastRun.membersTotal)} members: ${counts(lastRun)};
        ${String(lastRun.requests)} Meetup client calls.
      </p>`
    : html`<p>No run yet.</p>`;
  const running = openRun
    ? html`<p>
        Running: ${String(openRun.membersDone)} of
        ${String(openRun.membersTotal)} members (${counts(openRun)}), started
        ${pacificDateTime(openRun.startedAt)} Pacific;
        ${String(openRun.requests)} Meetup client calls so far.
      </p>`
    : '';
  let nextSweep = 'as soon as the job runs';
  if (openRun) {
    nextSweep = 'running now';
  } else if (lastRun?.finishedAt) {
    nextSweep = `${pacificDateTime(new Date(lastRun.finishedAt.getTime() + RUN_INTERVAL_MS))} Pacific`;
  }
  const nextTick = status.nextTickAt
    ? `${pacificTime(status.nextTickAt)} Pacific`
    : 'the job is not running';
  const queue = html`<p class="muted">
      Queue: ${String(status.queueLength)} · Stored Wrapped entries:
      ${String(status.entries)}
    </p>
    <p class="muted">Next tick: ${nextTick} · Next sweep: ${nextSweep}</p>`;
  const form =
    !openRun && view.csrfToken !== undefined
      ? html`<form method="post" action="${localUrl(WRAPPED_BACKFILL_PATH)}">
          <input type="hidden" name="_csrf" value="${view.csrfToken}" />
          <button type="submit" class="ghost">Run now</button>
          <span class="muted">1.5 Leadership Team only.</span>
        </form>`
      : '';
  return html`<div class="card">
    <h2>Wrapped backfill</h2>
    ${backfillNotice(view.backfillNotice)} ${last} ${running} ${queue} ${form}
  </div>`;
}

const back = (code: BackfillNoticeCode) => `/dashboard?backfill=${code}`;

/**
 * POST /dashboard/wrapped/backfill/run: asks the next tick to start a run.
 * 1.5 Leadership Team only, asked of Discord live. CSRF, Origin,
 * Sec-Fetch-Site and the per-user action rate limit are the router's
 * unsafe-method guard, which runs before this handler.
 */
export function registerWrappedBackfillRoute(
  router: express.Router,
  deps: Pick<DashboardPageDeps, 'isLeadership' | 'audit' | 'wrappedBackfill'>,
): void {
  const audit = (entry: LogEntry) => {
    Promise.resolve()
      .then(() => deps.audit(entry))
      .catch((error: unknown) =>
        logger.warn(
          `Dashboard audit post failed: ${error instanceof Error ? error.name : 'Error'}`,
        ),
      );
  };

  router.post(DASHBOARD_PATHS.wrappedBackfill, (async (_req, res) => {
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
    let outcome: RunNowOutcome;
    try {
      outcome = await deps.wrappedBackfill.runNow(session.userId);
    } catch (error: unknown) {
      logger.warn(
        `Wrapped backfill Run now failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      res.redirect(303, back('error'));
      return;
    }
    if (outcome === 'requested') {
      audit({
        title: 'Wrapped backfill requested',
        description: `<@${session.userId}> asked for a Wrapped backfill run from the staff dashboard.`,
      });
    }
    res.redirect(303, back(outcome));
  }) as RequestHandler);
}

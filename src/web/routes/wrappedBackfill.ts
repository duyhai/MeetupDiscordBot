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
import { SnapshotRun } from '../../lib/repositories/postgresSnapshotRepository.js';
import { LastSnapshotTick, SnapshotTuning } from '../../lib/snapshot/ingest.js';
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
export const SNAPSHOT_REFRESH_PATH = dashboardPath(
  DASHBOARD_PATHS.snapshotRefresh,
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

/** The group snapshot's state, for one line on the card. */
export interface SnapshotStatus {
  lastRun: SnapshotRun | undefined;
  openRun: SnapshotRun | undefined;
  /** Rows in meetup_events / meetup_event_rsvps. */
  events: number;
  rsvps: number;
  /** Events the open run still has to read. */
  pending: number;
  /** Live events whose last RSVP read failed. */
  failing: number;
  /** Live events whose short read was accepted (attendees left Meetup). */
  hidden: number;
  /** The configured pace (SNAPSHOT_CALLS_PER_TICK, SNAPSHOT_CONCURRENCY). */
  pace: SnapshotTuning;
  /** The last tick that ran; undefined when none in the last day. */
  lastTick: LastSnapshotTick | undefined;
  now: Date;
}

export type RunNowOutcome =
  'requested' | 'already-running' | 'already-requested';

/** What the card reads and Run now does; production wires the repository and the cache. */
export interface WrappedBackfillControl {
  status(): Promise<BackfillStatus>;
  runNow(requestedBy: string): Promise<RunNowOutcome>;
  snapshot(): Promise<SnapshotStatus>;
  /** Asks the next snapshot tick to start a run (the snapshot's Run now). */
  refreshSnapshot(requestedBy: string): Promise<RunNowOutcome>;
}

type Refusal = 'not-leadership' | 'unavailable' | 'error';

export type BackfillNoticeCode =
  RunNowOutcome | Refusal | `snapshot-${RunNowOutcome | Refusal}`;

/** Fixed text per code. Nothing from the request, the store or Discord is ever shown. */
export const BACKFILL_NOTICES = {
  requested:
    'The Wrapped backfill will start on its next tick (within 5 minutes).',
  'already-running': 'A Wrapped backfill run is already in progress.',
  'already-requested': 'Run now was already pressed; the next tick starts it.',
  'snapshot-requested':
    'The group snapshot will refresh on its next tick (within 5 minutes).',
  'snapshot-already-running': 'A group snapshot run is already in progress.',
  'snapshot-already-requested':
    'Refresh snapshot now was already pressed; the next tick starts it.',
  'snapshot-not-leadership':
    'Only the 1.5 Leadership Team can refresh the group snapshot.',
  'snapshot-unavailable':
    'Discord could not be reached to check your role. Nothing was requested; try again in a minute.',
  'snapshot-error':
    'The snapshot refresh could not be requested. Please try again later.',
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
  return code === 'requested' || code === 'snapshot-requested'
    ? html`<p class="note info">${BACKFILL_NOTICES[code]}</p>`
    : html`<p class="note attn">${BACKFILL_NOTICES[code]}</p>`;
}

const pacificTime = (at: Date) => tz(dayjs(at)).format('h:mm A');

const n = (value: number) => value.toLocaleString('en-US');

function age(from: Date, now: Date): string {
  const minutes = Math.max(
    0,
    Math.floor((now.getTime() - from.getTime()) / 60_000),
  );
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

/** The snapshot line: fixed text and numbers only; a failing read degrades to a fixed line. */
async function snapshotLine(
  deps: Pick<DashboardPageDeps, 'wrappedBackfill'>,
  csrfToken: string | undefined,
): Promise<SafeHtml> {
  let status: SnapshotStatus;
  try {
    status = await deps.wrappedBackfill.snapshot();
  } catch (error: unknown) {
    logger.warn(
      `Group snapshot status failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return html`<p class="muted">Group snapshot: status unavailable.</p>`;
  }
  const { lastRun, openRun } = status;
  const failed = (run: SnapshotRun | undefined): string => {
    return run?.lastError ? ` Last tick failed (${run.lastError}).` : '';
  };
  const parts: string[] = [];
  if (openRun) {
    const total = openRun.eventsFetched + status.pending;
    parts.push(
      `Group snapshot: refreshing (${openRun.kind}): ${n(openRun.eventsFetched)} of ~${n(total)} events read.` +
        failed(openRun),
    );
  }
  if (lastRun?.finishedAt) {
    parts.push(
      `Group snapshot: updated ${age(lastRun.finishedAt, status.now)} ago (${pacificDateTime(lastRun.finishedAt)} Pacific) · ` +
        `${n(status.events)} events · ${n(status.rsvps)} RSVPs · last run: ${lastRun.kind}, ` +
        `${n(lastRun.requests)} calls, ${n(lastRun.failed)} failed.${openRun ? '' : failed(lastRun)}`,
    );
  }
  if (parts.length === 0) {
    parts.push('Group snapshot: not pulled yet.');
  }
  const { pace, lastTick } = status;
  const tickAt = lastTick ? Date.parse(lastTick.at) : Number.NaN;
  const lastTickText = Number.isFinite(tickAt)
    ? ` · last tick ${age(new Date(tickAt), status.now)} ago: ${n(lastTick?.calls ?? 0)} calls, ` +
      `${n(lastTick?.fetched ?? 0)} events read` +
      (lastTick?.error ? ` (failed: ${lastTick.error})` : '')
    : '';
  parts.push(
    `Pace: ${n(pace.callsPerTick)} Meetup calls a tick, ${n(pace.concurrency)} at a time${lastTickText}.`,
  );
  if (status.hidden > 0) {
    parts.push(
      `${n(status.hidden)} events have RSVPs Meetup no longer shows (their attendees left Meetup).`,
    );
  }
  if (status.failing > 0) {
    parts.push(
      `${n(status.failing)} events failed their last RSVP read; they are retried each run.`,
    );
  }
  const form =
    !openRun && csrfToken !== undefined
      ? html`<form method="post" action="${localUrl(SNAPSHOT_REFRESH_PATH)}">
          <input type="hidden" name="_csrf" value="${csrfToken}" />
          <button type="submit" class="ghost">Refresh snapshot now</button>
          <span class="muted">1.5 Leadership Team only.</span>
        </form>`
      : '';
  return html`${parts.map((text) => html`<p class="muted">${text}</p>`)} ${form}`;
}

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
    ${await snapshotLine(deps, view.csrfToken)}
  </div>`;
}

const back = (code: BackfillNoticeCode) => `/dashboard?backfill=${code}`;

/**
 * POST /dashboard/wrapped/backfill/run: asks the next tick to start a run;
 * POST /dashboard/wrapped/snapshot/run: the same for the group snapshot.
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

  const leadershipPost = (
    path: string,
    act: (requestedBy: string) => Promise<RunNowOutcome>,
    code: (outcome: RunNowOutcome | Refusal) => BackfillNoticeCode,
    auditEntry: (userId: string) => LogEntry,
    label: string,
  ) => {
    router.post(path, (async (_req, res) => {
      const { session } = dashboardLocals(res);
      let leader: boolean;
      try {
        leader = await deps.isLeadership(session.userId);
      } catch (error: unknown) {
        logger.warn(
          `Dashboard Leadership check failed: ${error instanceof Error ? error.name : 'Error'}`,
        );
        res.redirect(303, back(code('unavailable')));
        return;
      }
      if (leader !== true) {
        res.redirect(303, back(code('not-leadership')));
        return;
      }
      let outcome: RunNowOutcome;
      try {
        outcome = await act(session.userId);
      } catch (error: unknown) {
        logger.warn(
          `${label} failed: ${error instanceof Error ? error.name : 'Error'}`,
        );
        res.redirect(303, back(code('error')));
        return;
      }
      if (outcome === 'requested') {
        audit(auditEntry(session.userId));
      }
      res.redirect(303, back(code(outcome)));
    }) as RequestHandler);
  };

  leadershipPost(
    DASHBOARD_PATHS.wrappedBackfill,
    (by) => deps.wrappedBackfill.runNow(by),
    (outcome) => outcome,
    (userId) => ({
      title: 'Wrapped backfill requested',
      description: `<@${userId}> asked for a Wrapped backfill run from the staff dashboard.`,
    }),
    'Wrapped backfill Run now',
  );
  leadershipPost(
    DASHBOARD_PATHS.snapshotRefresh,
    (by) => deps.wrappedBackfill.refreshSnapshot(by),
    (outcome) => `snapshot-${outcome}`,
    (userId) => ({
      title: 'Group snapshot refresh requested',
      description: `<@${userId}> asked for a group snapshot refresh from the staff dashboard.`,
    }),
    'Group snapshot refresh',
  );
}

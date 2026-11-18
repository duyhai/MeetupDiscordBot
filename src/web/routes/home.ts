import { Logger } from 'tslog';

import {
  DASHBOARD_PATHS,
  dashboardPath,
  linkableMonthPath,
} from '../../lib/reports/dashboardPaths.js';
import {
  Period,
  monthLabel,
  periodKey,
  periodOf,
  previousPeriod,
} from '../../lib/reports/period.js';
import { SnapshotMeta } from '../../lib/repositories/postgresReportSnapshotRepository.js';
import { isWorkspaceMonth } from '../../lib/workspace/months.js';
import {
  DONE_STATUSES,
  OPEN_STATUSES,
  PARKED_STATUSES,
  WorkspaceStatus,
} from '../../lib/workspace/types.js';
import type { HomeReportsView } from '../dashboardRouter.js';
import type { EventRequest } from '../../lib/repositories/postgresEventRequestRepository.js';
import { SafeHtml, html, localUrl, memberText } from '../html.js';
import { pacificDateTime, zeroNoShowNote } from '../pageKit.js';
import type { DashboardPageDeps } from './dashboardPages.js';
import { collapsible } from '../ui/index.js';
import { whenLabel } from './hostRequests.js';
import { identityChangesTable, isListRow } from './identity.js';
import { wrappedBackfillCard } from './wrappedBackfill.js';

const logger = new Logger({ name: 'dashboard' });

/** The one line a failed card shows. Fixed text: nothing from the error reaches the page. */
const UNAVAILABLE = html`<p class="muted">Unavailable right now.</p>`;

/** A stored summary field as a number: anything else (including text) is 0. */
const num = (summary: unknown, key: string): number => {
  const n = Number(
    (summary as Record<string, unknown> | null | undefined)?.[key],
  );
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** How long the report cards may take together; a card still pending then shows the fixed line. */
export const HOME_REPORTS_DEADLINE_MS = 5000;

const TIMED_OUT = Symbol('timed out');

/**
 * Runs one card; a failure or the shared deadline renders the fixed line for
 * that card only. A failure logs the class name only.
 */
async function card(
  name: string,
  deadline: Promise<typeof TIMED_OUT>,
  render: () => Promise<SafeHtml>,
): Promise<SafeHtml> {
  const unavailable = html`<div class="card">${UNAVAILABLE}</div>`;
  try {
    const result = await Promise.race([render(), deadline]);
    if (result === TIMED_OUT) {
      logger.warn(`Dashboard ${name} card timed out`);
      return unavailable;
    }
    return result;
  } catch (error) {
    logger.warn(
      `Dashboard ${name} card failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return unavailable;
  }
}

/** The month's no-show and Hall of Fame summaries, each linking to its page. */
function reportsBody(
  period: Period,
  noShow: SnapshotMeta | undefined,
  hallOfFame: SnapshotMeta | undefined,
  now: Date,
): SafeHtml {
  if (!noShow || !hallOfFame) {
    return html`<p class="muted">
      The ${monthLabel(period)} reports have not been built yet.
    </p>`;
  }
  const historyPath = linkableMonthPath(
    DASHBOARD_PATHS.noShowHistoryMonth,
    period,
  );
  const history =
    historyPath === undefined
      ? ''
      : html` (<a href="${localUrl(historyPath)}">no-show history</a>)`;
  const famePath = linkableMonthPath(DASHBOARD_PATHS.hallOfFameMonth, period);
  const fame =
    famePath === undefined
      ? html`Hall of Fame`
      : html`<a href="${localUrl(famePath)}">Hall of Fame</a>`;
  return html`<p>
      No-shows: ${num(noShow.summary, 'noShows')} no-show RSVPs,
      ${num(noShow.summary, 'warnings')} warnings,
      ${num(noShow.summary, 'suspensionCandidates')} suspension
      candidates${history}
    </p>
    <p>
      ${fame}: ${num(hallOfFame.summary, 'events')} events,
      ${num(hallOfFame.summary, 'hosts')} hosts
      (${num(hallOfFame.summary, 'newHosts')} new)
    </p>
    ${zeroNoShowNote(period, noShow.attendance, now)}
    <p class="muted">Built ${pacificDateTime(noShow.builtAt)} Pacific</p>`;
}

/** The workspace months' counts and states: one aggregate, never row lists. */
interface WorkspaceRead {
  counts: Map<string, Partial<Record<WorkspaceStatus, number>>>;
  states: Map<string, boolean>;
}

async function readWorkspace(
  deps: Pick<DashboardPageDeps, 'workspace'>,
  months: Period[],
): Promise<WorkspaceRead> {
  if (months.length === 0) {
    return { counts: new Map(), states: new Map() };
  }
  const ws = await deps.workspace();
  const [counts, states] = await Promise.all([
    ws.statusCounts(months),
    Promise.all(months.map((p) => ws.monthState(p))),
  ]);
  return {
    counts,
    states: new Map(months.map((p, i) => [periodKey(p), Boolean(states[i])])),
  };
}

/** A month's workspace tiles; To do is undefined when there is nothing to count. */
function workspaceSection(
  period: Period,
  read: WorkspaceRead | undefined,
): { body: SafeHtml; todo?: number } {
  // The collapsible's title already names the month.
  const path = linkableMonthPath(DASHBOARD_PATHS.workspaceMonth, period);
  // prettier-ignore
  const heading = path === undefined
    ? html`<h3>No-show workspace</h3>`
    : html`<h3><a href="${localUrl(path)}">No-show workspace</a></h3>`;
  if (read === undefined) {
    return { body: html`${heading}${UNAVAILABLE}` };
  }
  if (!read.states.get(periodKey(period))) {
    return {
      body: html`${heading}
        <p class="muted">Not set up yet</p>`,
    };
  }
  const c = read.counts.get(periodKey(period)) ?? {};
  const sum = (list: readonly WorkspaceStatus[]) =>
    list.reduce((n, s) => n + num(c, s), 0);
  const todo = sum(OPEN_STATUSES);
  // Three tiles. Classes are literals; only the counts are data.
  return {
    todo,
    body: html`${heading}
      <dl class="stats">
        <div class="stat todo">
          <dt>To do</dt>
          <dd>${todo}</dd>
        </div>
        <div class="stat">
          <dt>On hold</dt>
          <dd>${sum(PARKED_STATUSES)}</dd>
        </div>
        <div class="stat done">
          <dt>Done</dt>
          <dd>${sum(DONE_STATUSES)}</dd>
        </div>
      </dl>`,
  };
}

/** How many waiting requests the home page reads; more shows as "50+". */
const PENDING_READ = 50;
/** How many of them it lists. */
const PENDING_SHOWN = 5;

/** Waiting host requests, oldest first (as the queue is worked): a count, the first few, and the queue link. */
function hostRequestsSection(pending: EventRequest[] | undefined): {
  body: SafeHtml;
  meta: string;
  open: boolean;
} {
  // prettier-ignore
  const queue = html`<p><a href="${localUrl(dashboardPath(DASHBOARD_PATHS.hostRequests))}">Open the host requests queue</a></p>`;
  if (pending === undefined) {
    return { body: html`${UNAVAILABLE}${queue}`, meta: '', open: false };
  }
  if (pending.length === 0) {
    return {
      body: html`<p class="muted">No requests are waiting.</p>
        ${queue}`,
      meta: 'None waiting',
      open: false,
    };
  }
  const count =
    pending.length >= PENDING_READ ? `${PENDING_READ}+` : `${pending.length}`;
  const items = pending
    .slice(0, PENDING_SHOWN)
    .map(
      (r) =>
        html`<li>
          <strong>${memberText(r.title)}</strong> · ${memberText(r.hostName)} ·
          ${whenLabel(r.startLocal)}
        </li>`,
    );
  const more =
    pending.length > PENDING_SHOWN
      ? html`<p class="muted">
          ${
            pending.length >= PENDING_READ
              ? 'And more in the queue.'
              : `And ${pending.length - PENDING_SHOWN} more in the queue.`
          }
        </p>`
      : '';
  return {
    body: html`<ul>
        ${items}
      </ul>
      ${more}${queue}`,
    meta: `${count} waiting`,
    open: true,
  };
}

/** The latest identity changes, inline: at most IDENTITY_SHOWN rows, newest first. */
const IDENTITY_SHOWN = 10;

async function identityCard(
  deps: Pick<DashboardPageDeps, 'identity'>,
): Promise<SafeHtml> {
  const reader = await deps.identity();
  const rows = await reader.listChangesPage({ limit: IDENTITY_SHOWN });
  if (!Array.isArray(rows) || !rows.every(isListRow)) {
    throw new TypeError('identity rows');
  }
  const names =
    rows.length === 0
      ? new Map<string, string>()
      : await reader.listIdentityNames(
          rows.map((r) => ({
            platform: r.platform,
            scopeId: r.scopeId,
            subjectId: r.subjectId,
          })),
        );
  if (!(names instanceof Map)) {
    throw new TypeError('identity names');
  }
  // prettier-ignore
  const all = html`<p><a href="${localUrl(dashboardPath(DASHBOARD_PATHS.identity))}">See all identity changes</a></p>`;
  return html`<div class="card">
    <h2>Identity changes</h2>
    ${
      rows.length === 0
        ? html`<p class="muted">No identity changes recorded yet.</p>`
        : html`<p class="muted">
              The latest ${IDENTITY_SHOWN}, newest first. Dates are Pacific.
            </p>
            ${identityChangesTable(rows, names)}`
    }
    ${all}
  </div>`;
}

/** Runs one part of a card; a failure or the deadline gives undefined. Logs the class name only. */
async function part<T>(
  name: string,
  deadline: Promise<typeof TIMED_OUT>,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    const result = await Promise.race([run(), deadline]);
    if (result === TIMED_OUT) {
      logger.warn(`Dashboard home ${name} timed out`);
      return undefined;
    }
    return result;
  } catch (error) {
    logger.warn(
      `Dashboard home ${name} failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return undefined;
  }
}

/** The shared deadline: resolves TIMED_OUT after HOME_REPORTS_DEADLINE_MS, unref'd. */
function startDeadline(): {
  deadline: Promise<typeof TIMED_OUT>;
  stop: () => void;
} {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), HOME_REPORTS_DEADLINE_MS);
    timer.unref();
  });
  return { deadline, stop: () => clearTimeout(timer) };
}

/**
 * The Home page's cards. One card groups what staff work on: each month
 * (the open one first, open; the latest finished one folded) as a
 * collapsible with its workspace counts, its no-show summary and its Hall
 * of Fame summary, then the waiting host requests. Then the latest
 * identity changes, inline. Reads summaries, counts and meta only, never a
 * full report payload. Never rejects: each part degrades on its own.
 */
export async function renderHomeReports(
  deps: Pick<
    DashboardPageDeps,
    'now' | 'snapshots' | 'identity' | 'workspace' | 'eventRequests'
  >,
): Promise<SafeHtml> {
  const { deadline, stop } = startDeadline();
  try {
    const now = deps.now();
    const open = periodOf(now);
    const finished = previousPeriod(open);
    const months = [open, finished];
    // One lookup, shared; a rejection reaches each month's own catch.
    const snapshotsOnce = Promise.resolve().then(() => deps.snapshots());
    snapshotsOnce.catch(() => undefined);
    // The aggregate reads oldest first.
    const workspaceMonths = [finished, open].filter((p) =>
      isWorkspaceMonth(p, now),
    );
    const workspaceRead: Promise<WorkspaceRead | undefined> = part(
      'workspace',
      deadline,
      () => readWorkspace(deps, workspaceMonths),
    );
    const reportsRead: Promise<SafeHtml[]> = Promise.all(
      months.map(async (p) => {
        const body = await part(
          `${periodKey(p)} reports`,
          deadline,
          async () => {
            const snapshots = await snapshotsOnce;
            const [noShow, hallOfFame] = await Promise.all([
              snapshots.getCurrentMeta('no_show', p),
              snapshots.getCurrentMeta('hall_of_fame', p),
            ]);
            return reportsBody(p, noShow, hallOfFame, now);
          },
        );
        return body ?? UNAVAILABLE;
      }),
    );
    const pendingRead: Promise<EventRequest[] | undefined> = part(
      'host requests',
      deadline,
      async () =>
        (await deps.eventRequests()).listByStatus(
          ['pending'],
          PENDING_READ,
          'oldest',
        ),
    );
    const identityRead: Promise<SafeHtml | undefined> = part(
      'identity',
      deadline,
      () => identityCard(deps),
    );
    const [workspace, reports, pending, identity] = await Promise.all([
      workspaceRead,
      reportsRead,
      pendingRead,
      identityRead,
    ]);
    const monthSections = months.map((p, i) => {
      const ws = workspaceMonths.some((m) => periodKey(m) === periodKey(p))
        ? workspaceSection(p, workspace)
        : undefined;
      const metaParts = [
        p === open ? 'So far this month' : '',
        ws?.todo === undefined ? '' : `${ws.todo} to do`,
      ].filter((t) => t !== '');
      return collapsible({
        summary: monthLabel(p),
        meta: metaParts.join(' · '),
        open: p === open,
        body: html`${ws ? ws.body : ''}
          <h3>Reports</h3>
          ${reports[i]}`,
      });
    });
    const requests = hostRequestsSection(pending);
    const overview = html`<div class="card">
      <h2>This month and last</h2>
      ${monthSections}
      ${collapsible({
        summary: 'Host requests',
        meta: requests.meta,
        open: requests.open,
        body: requests.body,
      })}
    </div>`;
    const identityHtml =
      identity ??
      html`<div class="card">
        <h2>Identity changes</h2>
        ${UNAVAILABLE}
      </div>`;
    return html`${overview}${identityHtml}`;
  } catch (error) {
    logger.warn(
      `Dashboard home reports failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return html``;
  } finally {
    stop();
  }
}

/**
 * The Settings page's job card: the Wrapped backfill. `view` carries the
 * CSRF token for the card's own forms and the `?backfill=` notice code its
 * POSTs redirect back with. Never rejects: the card degrades on its own.
 */
export async function renderSettingsCards(
  deps: Pick<DashboardPageDeps, 'wrappedBackfill'>,
  view: Partial<HomeReportsView> = {},
): Promise<SafeHtml> {
  const { deadline, stop } = startDeadline();
  try {
    return await card('wrapped backfill', deadline, () =>
      wrappedBackfillCard(deps, view),
    );
  } finally {
    stop();
  }
}

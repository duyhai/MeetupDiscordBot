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
import { SafeHtml, html, localUrl } from '../html.js';
import { monthCell, pacificDateTime, zeroNoShowNote } from '../pageKit.js';
import type { DashboardPageDeps } from './dashboardPages.js';

const logger = new Logger({ name: 'dashboard' });

const DAY_MS = 24 * 3600 * 1000;

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
      logger.warn(`Dashboard home ${name} card timed out`);
      return unavailable;
    }
    return result;
  } catch (error) {
    logger.warn(
      `Dashboard home ${name} card failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return unavailable;
  }
}

function monthBody(
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
  return html`<p>
      No-shows: ${num(noShow.summary, 'noShows')} no-show RSVPs,
      ${num(noShow.summary, 'warnings')} warnings,
      ${num(noShow.summary, 'suspensionCandidates')} suspension
      candidates${history}
    </p>
    <p>
      Hall of Fame: ${num(hallOfFame.summary, 'events')} events,
      ${num(hallOfFame.summary, 'hosts')} hosts
      (${num(hallOfFame.summary, 'newHosts')} new)
    </p>
    ${zeroNoShowNote(period, noShow.attendance, now)}
    <p class="muted">Built ${pacificDateTime(noShow.builtAt)} Pacific</p>`;
}

async function monthCard(
  snapshotsOnce: Promise<Awaited<ReturnType<DashboardPageDeps['snapshots']>>>,
  period: Period,
  now: Date,
  open: boolean,
): Promise<SafeHtml> {
  const snapshots = await snapshotsOnce;
  const [noShow, hallOfFame] = await Promise.all([
    snapshots.getCurrentMeta('no_show', period),
    snapshots.getCurrentMeta('hall_of_fame', period),
  ]);
  return html`<div class="card">
    <h2>${monthCell(DASHBOARD_PATHS.hallOfFameMonth, period)}</h2>
    ${open ? html`<p class="muted">So far this month</p>` : ''}
    ${monthBody(period, noShow, hallOfFame, now)}
  </div>`;
}

/**
 * Open workspace items for the latest finished and the open month: one
 * aggregate (statusCounts) over at most those two months, never row lists.
 * Months before the workspace have no line; with none, no card.
 */
async function workspaceCard(
  deps: Pick<DashboardPageDeps, 'workspace'>,
  months: Period[],
): Promise<SafeHtml> {
  if (months.length === 0) {
    return html``;
  }
  const counts = await (await deps.workspace()).statusCounts(months);
  const line = (p: Period) => {
    const c = counts.get(periodKey(p)) ?? {};
    const sum = (list: readonly WorkspaceStatus[]) =>
      list.reduce((n, s) => n + num(c, s), 0);
    return html`<li>
      ${monthCell(DASHBOARD_PATHS.workspaceMonth, p)}: ${sum(OPEN_STATUSES)} to
      do, ${sum(PARKED_STATUSES)} on hold, ${sum(DONE_STATUSES)} done
    </li>`;
  };
  return html`<div class="card">
    <h2>
      <a href="${localUrl(dashboardPath(DASHBOARD_PATHS.workspace))}"
        >No-show workspace</a
      >
    </h2>
    <ul>
      ${months.map(line)}
    </ul>
  </div>`;
}

/**
 * The Home page's report cards. Reads summaries and meta only, never a full
 * payload. Never rejects: each card degrades on its own.
 */
export async function renderHomeReports(
  deps: Pick<
    DashboardPageDeps,
    'now' | 'snapshots' | 'identity' | 'linkProgress' | 'workspace'
  >,
): Promise<SafeHtml> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const now = deps.now();
    const open = periodOf(now);
    const finished = previousPeriod(open);
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), HOME_REPORTS_DEADLINE_MS);
      timer.unref();
    });
    // One lookup, shared; a rejection reaches each month card's own catch.
    const snapshotsOnce = Promise.resolve().then(() => deps.snapshots());
    snapshotsOnce.catch(() => undefined);
    const workspaceMonthsShown = [finished, open].filter((p) =>
      isWorkspaceMonth(p, now),
    );
    const [workspace, finishedCard, openCard, identityCard, linkCard] =
      await Promise.all([
        card('workspace', deadline, () =>
          workspaceCard(deps, workspaceMonthsShown),
        ),
        card('finished month', deadline, () =>
          monthCard(snapshotsOnce, finished, now, false),
        ),
        card('open month', deadline, () =>
          monthCard(snapshotsOnce, open, now, true),
        ),
        card('identity', deadline, async () => {
          const identity = await deps.identity();
          const changes = await identity.countChangesSince(
            new Date(now.getTime() - 7 * DAY_MS),
          );
          return html`<div class="card">
            <h2>Identity changes</h2>
            <p>
              <a href="${localUrl(dashboardPath(DASHBOARD_PATHS.identity))}"
                >${num({ changes }, 'changes')} identity changes in the last 7
                days</a
              >
            </p>
          </div>`;
        }),
        card('link progress', deadline, async () => {
          const [day] = await (await deps.linkProgress()).listDays(1);
          return html`<div class="card">
            <h2>
              <a href="${localUrl(dashboardPath(DASHBOARD_PATHS.linkProgress))}"
                >Link progress</a
              >
            </h2>
            ${
              day
                ? html`<p>
                    Linked ${day.linked}, unlinked ${day.unlinked},
                    Reverify-tagged ${day.reverifyTagged}, onboarding
                    ${day.onboarding} on ${day.day}
                  </p>`
                : html`<p class="muted">No link progress recorded yet.</p>`
            }
          </div>`;
        }),
      ]);
    // The workspace card first: it is what staff act on.
    return html`${workspace}${finishedCard}${openCard}${identityCard}${linkCard}`;
  } catch (error) {
    logger.warn(
      `Dashboard home reports failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return html``;
  } finally {
    clearTimeout(timer);
  }
}

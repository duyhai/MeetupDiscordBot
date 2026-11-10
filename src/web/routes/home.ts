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
import {
  announceDueAt,
  announceSchedule,
  announceYear,
} from '../../lib/wrapped/announce.js';
import type { HomeReportsView } from '../dashboardRouter.js';
import { SafeHtml, html, localUrl } from '../html.js';
import { monthCell, pacificDateTime, zeroNoShowNote } from '../pageKit.js';
import type { DashboardPageDeps } from './dashboardPages.js';
import { WRAPPED_ANNOUNCE_PATH, wrappedNotice } from './wrappedAnnounce.js';

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
 * aggregate (statusCounts) over at most those two months, and each month's
 * state, never row lists. A month not set up yet says so, like the months
 * list. Months before the workspace have no line; with none, no card.
 */
async function workspaceCard(
  deps: Pick<DashboardPageDeps, 'workspace'>,
  months: Period[],
): Promise<SafeHtml> {
  if (months.length === 0) {
    return html``;
  }
  const ws = await deps.workspace();
  const [counts, states] = await Promise.all([
    ws.statusCounts(months),
    Promise.all(months.map((p) => ws.monthState(p))),
  ]);
  // Each month: three tiles. Classes are literals; only the counts are data.
  const month = (p: Period, i: number) => {
    const heading = html`<h3>
      ${monthCell(DASHBOARD_PATHS.workspaceMonth, p)}
    </h3>`;
    if (!states[i]) {
      return html`<section class="ws-month">
        ${heading}
        <p class="muted">Not set up yet</p>
      </section>`;
    }
    const c = counts.get(periodKey(p)) ?? {};
    const sum = (list: readonly WorkspaceStatus[]) =>
      list.reduce((n, s) => n + num(c, s), 0);
    return html`<section class="ws-month">
      ${heading}
      <dl class="stats">
        <div class="stat todo">
          <dt>To do</dt>
          <dd>${sum(OPEN_STATUSES)}</dd>
        </div>
        <div class="stat">
          <dt>On hold</dt>
          <dd>${sum(PARKED_STATUSES)}</dd>
        </div>
        <div class="stat done">
          <dt>Done</dt>
          <dd>${sum(DONE_STATUSES)}</dd>
        </div>
      </dl>
    </section>`;
  };
  return html`<div class="card">
    <h2>
      <a href="${localUrl(dashboardPath(DASHBOARD_PATHS.workspace))}"
        >No-show workspace</a
      >
    </h2>
    ${months.map(month)}
  </div>`;
}

/**
 * The Wrapped announcement: what is configured (date and hour Pacific, the
 * channel), whether this year's post went out (when, where), and Post now
 * for Leadership while it has not. The form needs the session's CSRF token;
 * a render without one (a bare card) shows the state only. Ids are digits,
 * so they are shown as text, never as links.
 */
async function wrappedCard(
  deps: Pick<DashboardPageDeps, 'wrappedAnnounce'>,
  view: Partial<HomeReportsView>,
): Promise<SafeHtml> {
  const config = deps.wrappedAnnounce.config();
  const schedule = announceSchedule(config);
  const status = await deps.wrappedAnnounce.status();
  const posted = status?.postedAt !== undefined;
  const state = posted
    ? html`<p>
        Posted ${pacificDateTime(status.postedAt)} Pacific in channel
        ${status.channelId ?? 'unknown'}${
          status.messageId ? html` (message ${status.messageId})` : ''
        }.
      </p>`
    : config.date !== undefined
      ? html`<p>Not posted yet for ${announceYear({ date: config.date })}.</p>`
      : '';
  let where: SafeHtml;
  if (config.date === undefined) {
    where = html`<p class="muted">
      WRAPPED_ANNOUNCE_DATE is not a real date: nothing will be posted.
    </p>`;
  } else if (schedule === undefined) {
    where = html`<p class="muted">
      WRAPPED_ANNOUNCE_CHANNEL_ID is not set: nothing will be posted.
    </p>`;
  } else {
    where = html`<p class="muted">
      Scheduled for ${pacificDateTime(announceDueAt(schedule))} Pacific in
      channel ${schedule.channelId}.
    </p>`;
  }
  const form =
    !posted && schedule !== undefined && view.csrfToken !== undefined
      ? html`<form method="post" action="${localUrl(WRAPPED_ANNOUNCE_PATH)}">
          <input type="hidden" name="_csrf" value="${view.csrfToken}" />
          <button type="submit" class="ghost">Post now</button>
          <span class="muted">1.5 Leadership Team only.</span>
        </form>`
      : '';
  return html`<div class="card">
    <h2>Wrapped announcement</h2>
    ${wrappedNotice(view.notice)} ${where} ${state} ${form}
  </div>`;
}

/**
 * The Home page's report cards. Reads summaries and meta only, never a full
 * payload. Never rejects: each card degrades on its own. `view` carries the
 * CSRF token for the cards' own forms and the `?wrapped=` notice code.
 */
export async function renderHomeReports(
  deps: Pick<
    DashboardPageDeps,
    | 'now'
    | 'snapshots'
    | 'identity'
    | 'linkProgress'
    | 'workspace'
    | 'wrappedAnnounce'
  >,
  view: Partial<HomeReportsView> = {},
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
    const [workspace, finishedCard, openCard, identityCard, linkCard, wrapped] =
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
                    Linked ${day.linked}, unlinked ${day.unlinked}, onboarding
                    ${day.onboarding} on ${day.day}
                  </p>`
                : html`<p class="muted">No link progress recorded yet.</p>`
            }
          </div>`;
        }),
        card('wrapped', deadline, () => wrappedCard(deps, view)),
      ]);
    // The workspace card first: it is what staff act on.
    return html`${workspace}${finishedCard}${openCard}${identityCard}${linkCard}${wrapped}`;
  } catch (error) {
    logger.warn(
      `Dashboard home reports failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return html``;
  } finally {
    clearTimeout(timer);
  }
}

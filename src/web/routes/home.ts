import { Logger } from 'tslog';

import {
  DASHBOARD_PATHS,
  dashboardPath,
  linkableMonthPath,
} from '../../lib/reports/dashboardPaths.js';
import {
  Period,
  monthLabel,
  periodOf,
  previousPeriod,
} from '../../lib/reports/period.js';
import { SnapshotMeta } from '../../lib/repositories/postgresReportSnapshotRepository.js';
import { SafeHtml, html, localUrl } from '../html.js';
import { monthCell, pacificDateTime, zeroNoShowNote } from '../pageKit.js';
import type { DashboardPageDeps } from './dashboardPages.js';

const logger = new Logger({ name: 'dashboard' });

const DAY_MS = 24 * 3600 * 1000;

/** The one line a failed card shows. Fixed text: nothing from the error reaches the page. */
const UNAVAILABLE = html`<p class="muted">Unavailable right now.</p>`;

/** A stored summary field as a number: anything else (including text) is 0. */
const num = (summary: unknown, key: string): number =>
  Number((summary as Record<string, unknown> | null | undefined)?.[key]) || 0;

/** Runs one card; a failure logs the class name only and renders the fixed line for that card. */
async function card(
  name: string,
  render: () => Promise<SafeHtml>,
): Promise<SafeHtml> {
  try {
    return await render();
  } catch (error) {
    logger.warn(
      `Dashboard home ${name} card failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return html`<div class="card">${UNAVAILABLE}</div>`;
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
  deps: Pick<DashboardPageDeps, 'snapshots'>,
  period: Period,
  now: Date,
  open: boolean,
): Promise<SafeHtml> {
  const snapshots = await deps.snapshots();
  const noShow = await snapshots.getCurrentMeta('no_show', period);
  const hallOfFame = await snapshots.getCurrentMeta('hall_of_fame', period);
  return html`<div class="card">
    <h2>${monthCell(DASHBOARD_PATHS.hallOfFameMonth, period)}</h2>
    ${open ? html`<p class="muted">So far this month</p>` : ''}
    ${monthBody(period, noShow, hallOfFame, now)}
  </div>`;
}

/**
 * The Home page's report cards. Reads summaries and meta only, never a full
 * payload. Never rejects: each card degrades on its own.
 */
export async function renderHomeReports(
  deps: Pick<
    DashboardPageDeps,
    'now' | 'snapshots' | 'identity' | 'linkProgress'
  >,
): Promise<SafeHtml> {
  try {
    const now = deps.now();
    const open = periodOf(now);
    const finished = previousPeriod(open);
    const finishedCard = await card('finished month', () =>
      monthCard(deps, finished, now, false),
    );
    const openCard = await card('open month', () =>
      monthCard(deps, open, now, true),
    );
    const identityCard = await card('identity', async () => {
      const identity = await deps.identity();
      const changes = await identity.countChangesSince(
        new Date(now.getTime() - 7 * DAY_MS),
      );
      return html`<div class="card">
        <h2>Identity changes</h2>
        <p>
          <a href="${localUrl(dashboardPath(DASHBOARD_PATHS.identity))}"
            >${Number(changes) || 0} identity changes in the last 7 days</a
          >
        </p>
      </div>`;
    });
    const linkCard = await card('link progress', async () => {
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
                Linked ${day.linked}, unlinked ${day.unlinked}, Reverify-tagged
                ${day.reverifyTagged}, onboarding ${day.onboarding} on
                ${day.day}
              </p>`
            : html`<p class="muted">No link progress recorded yet.</p>`
        }
      </div>`;
    });
    return html`${finishedCard}${openCard}${identityCard}${linkCard}`;
  } catch {
    return html``;
  }
}

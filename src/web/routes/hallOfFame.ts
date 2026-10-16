import express, { RequestHandler } from 'express';

import { formatHallOfFamePost } from '../../lib/helpers/hallOfFame.js';
import {
  DASHBOARD_PATHS,
  dashboardPath,
  monthPath,
} from '../../lib/reports/dashboardPaths.js';
import {
  Period,
  monthLabel,
  parsePeriodKey,
  periodKey,
} from '../../lib/reports/period.js';
import { HallOfFameEvent, HallOfFamePayload } from '../../lib/reports/types.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html, localUrl, pageLink } from '../html.js';
import { eventLink, memberLink } from '../links.js';
import {
  builtByHtml,
  dashboardPage,
  load,
  notFound,
  pacificDate,
  pacificDateTime,
  parseRouteMonth,
  unavailable,
} from '../pageKit.js';
import { PAGE_SIZE, pageNav, parsePage } from '../paging.js';
import type { DashboardPageDeps } from './dashboardPages.js';
import { refreshForm, refreshNotice } from './refresh.js';

const WHAT = 'The Hall of Fame report';

/** '2026 September': the label the slash command uses, so the copy text matches it. */
export function commandPeriodLabel(period: Period): string {
  const [monthName] = monthLabel(period).split(' ');
  return `${period.year} ${monthName}`;
}

const isHallOfFame = (p: unknown): p is HallOfFamePayload =>
  typeof p === 'object' &&
  p !== null &&
  (p as HallOfFamePayload).reportType === 'hall_of_fame' &&
  Array.isArray((p as HallOfFamePayload).hosts);

const count = (value: unknown): number => Number(value) || 0;

/** The number is an RSVP count (YES plus ATTENDED, which never comes back): "RSVPs", never attendance. */
function eventRow(e: HallOfFameEvent): SafeHtml {
  const rsvps = `${count(e.attendance)} RSVPs / ${count(e.maxTickets)} spots`;
  return html`<li>
    ${eventLink(e)}
    <span class="muted">${pacificDate(e.dateTime)} · ${rsvps}</span>
  </li>`;
}

function monthPage(
  payload: HallOfFamePayload,
  period: Period,
  page: number,
): { hosts: SafeHtml; post: string } {
  const start = (page - 1) * PAGE_SIZE;
  const rows = payload.hosts.slice(start, start + PAGE_SIZE);
  const hosts = html`<table>
      <thead>
        <tr>
          <th>#</th>
          <th>Host</th>
          <th>Events</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (h, i) =>
            html`<tr>
              <td>${start + i + 1}</td>
              <td>
                ${memberLink(h.host)}${
                  h.isNew ? html` <span class="badge">New host</span>` : ''
                }
              </td>
              <td>
                ${h.events.length}
                <ul>
                  ${h.events.map(eventRow)}
                </ul>
              </td>
            </tr>`,
        )}
      </tbody>
    </table>
    ${pageNav(
      monthPath(DASHBOARD_PATHS.hallOfFameMonth, period),
      page,
      start + PAGE_SIZE < payload.hosts.length,
    )}`;
  // Exactly the command's ready-to-post block.
  const post = formatHallOfFamePost({
    periodLabel: commandPeriodLabel(period),
    hostStats: payload.hosts,
    totalEvents: payload.totalEvents,
    newHostIds: new Set(
      payload.hosts.filter((h) => h.isNew).map((h) => h.host.id),
    ),
  });
  return { hosts, post };
}

export function registerHallOfFameRoutes(
  router: express.Router,
  deps: Pick<DashboardPageDeps, 'now' | 'snapshots'>,
): void {
  router.get(DASHBOARD_PATHS.hallOfFame, (async (req, res) => {
    const before =
      typeof req.query.before === 'string'
        ? parsePeriodKey(req.query.before)
        : undefined;
    const loaded = await load(res, 'The Hall of Fame reports', async () =>
      (await deps.snapshots()).listSummaries('hall_of_fame', {
        before,
        limit: PAGE_SIZE,
      }),
    );
    if (!loaded.ok) {
      return;
    }
    const metas = loaded.value;
    const last = metas[metas.length - 1];
    const older =
      metas.length === PAGE_SIZE && last
        ? html`<nav class="pager">
            <a
              href="${pageLink(dashboardPath(DASHBOARD_PATHS.hallOfFame), {
                before: periodKey(last.period),
              })}"
              >Older months</a
            >
          </nav>`
        : '';
    const table =
      metas.length === 0
        ? html`<p>No Hall of Fame reports have been built yet.</p>`
        : html`<table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Events</th>
                <th>Hosts</th>
                <th>New hosts</th>
                <th>Built</th>
              </tr>
            </thead>
            <tbody>
              ${metas.map((meta) => {
                const s = (meta.summary ?? {}) as Record<string, unknown>;
                return html`<tr>
                  <td>
                    <a
                      href="${localUrl(
                        monthPath(DASHBOARD_PATHS.hallOfFameMonth, meta.period),
                      )}"
                      >${monthLabel(meta.period)}</a
                    >
                  </td>
                  <td>${count(s.events)}</td>
                  <td>${count(s.hosts)}</td>
                  <td>${count(s.newHosts)}</td>
                  <td>${pacificDateTime(meta.builtAt)} Pacific</td>
                </tr>`;
              })}
            </tbody>
          </table>`;
    dashboardPage(res, {
      title: 'Hall of Fame',
      body: html`<div class="card">
        <h1>Hall of Fame</h1>
        ${table} ${older}
      </div>`,
    });
  }) as RequestHandler);

  router.get(DASHBOARD_PATHS.hallOfFameMonth, (async (req, res) => {
    const period = parseRouteMonth(req.params.period, deps.now());
    if (period === undefined) {
      notFound(res);
      return;
    }
    const loaded = await load(res, WHAT, async () =>
      (await deps.snapshots()).getCurrent('hall_of_fame', period),
    );
    if (!loaded.ok) {
      return;
    }
    const { session } = dashboardLocals(res);
    const snapshot = loaded.value;
    const label = monthLabel(period);
    const head = html`<h1>Hall of Fame — ${label}</h1>
      ${refreshNotice(req.query.refresh)}`;
    const refresh = refreshForm(period, session.csrfToken, 'hall-of-fame');
    if (!snapshot) {
      dashboardPage(res, {
        title: `Hall of Fame ${label}`,
        body: html`<div class="card">
          ${head}
          <p>The ${label} reports have not been built yet.</p>
          ${refresh}
        </div>`,
      });
      return;
    }
    if (!isHallOfFame(snapshot.payload)) {
      unavailable(res, WHAT);
      return;
    }
    const payload = snapshot.payload;
    const { hosts, post } = monthPage(
      payload,
      period,
      parsePage(req.query.page),
    );
    dashboardPage(res, {
      title: `Hall of Fame ${label}`,
      script: true,
      body: html`<div class="card">
          ${head}
          <p class="muted">
            Built ${pacificDateTime(snapshot.builtAt)} Pacific by
            ${builtByHtml(snapshot.builtBy)}; counts events up to
            ${pacificDateTime(payload.asOf)} Pacific.
          </p>
          <p>
            ${count(payload.summary?.events)} events ·
            ${count(payload.summary?.hosts)} hosts ·
            ${count(payload.summary?.newHosts)} new hosts
          </p>
          ${refresh}
        </div>
        <div class="card">
          <h2>Hosts</h2>
          ${hosts}
        </div>
        <div class="card">
          <h2>Ready to post</h2>
          <textarea id="hof-post" class="copy" readonly>${post}</textarea>
          <p><button type="button" data-copy="hof-post">Copy</button></p>
        </div>`,
    });
  }) as RequestHandler);
}

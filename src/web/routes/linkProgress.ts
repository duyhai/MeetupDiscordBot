import express, { RequestHandler } from 'express';

import {
  DASHBOARD_PATHS,
  dashboardPath,
} from '../../lib/reports/dashboardPaths.js';
import { LinkProgressDay } from '../../lib/repositories/postgresLinkProgressRepository.js';
import { chart } from '../charts.js';
import { SafeHtml, html, pageLink } from '../html.js';
import { dashboardPage, load, unavailable } from '../pageKit.js';
import { PAGE_SIZE, pageNav, parsePage } from '../paging.js';
import type { DashboardPageDeps } from './dashboardPages.js';

const WHAT = 'Link progress';
const DAY_CHOICES = ['30', '90', '365'] as const;
type DayChoice = (typeof DAY_CHOICES)[number];
const DEFAULT_DAYS: DayChoice = '90';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// reverifyTagged is still stored (0 since the Reverify role was deleted on
// 2026-10-17) but not shown, so the page neither checks nor renders it.
const COUNT_FIELDS = ['linked', 'unlinked', 'onboarding'] as const;

/** `?days=` when it is exactly one of the three choices (a plain string), else 90. */
function parseDays(value: unknown): DayChoice {
  return DAY_CHOICES.find((d) => d === value) ?? DEFAULT_DAYS;
}

/** A row the page can render; anything else is the 503 page, never a 500. */
function isDayRow(row: unknown): row is LinkProgressDay {
  if (typeof row !== 'object' || row === null) {
    return false;
  }
  const r = row as Record<string, unknown>;
  return (
    typeof r.day === 'string' &&
    DAY.test(r.day) &&
    COUNT_FIELDS.every((f) => Number.isSafeInteger(r[f]))
  );
}

function rangeNav(current: DayChoice): SafeHtml {
  const path = dashboardPath(DASHBOARD_PATHS.linkProgress);
  return html`<nav class="pager choices" aria-label="Range">
    ${DAY_CHOICES.map((days) => {
      if (days === current) {
        return html`<strong>${days} days</strong>`;
      }
      return html`<a href="${pageLink(path, { days })}">${days} days</a>`;
    })}
  </nav>`;
}

function daysTable(
  newestFirst: LinkProgressDay[],
  days: DayChoice,
  page: number,
): SafeHtml {
  const start = (page - 1) * PAGE_SIZE;
  const rows = newestFirst.slice(start, start + PAGE_SIZE);
  const pager = pageNav(
    dashboardPath(DASHBOARD_PATHS.linkProgress),
    page,
    newestFirst.length > start + PAGE_SIZE,
    { days },
  );
  if (rows.length === 0) {
    return html`<p>No more days.</p>
      ${pager}`;
  }
  return html`<div class="table-scroll">
      <table class="days">
        <thead>
          <tr>
            <th>Day</th>
            <th>Linked</th>
            <th>Unlinked</th>
            <th>Onboarding</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (r) =>
              html`<tr>
                <td>${r.day}</td>
                <td>${r.linked}</td>
                <td>${r.unlinked}</td>
                <td>${r.onboarding}</td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>
    ${pager}`;
}

function progressChart(newestFirst: LinkProgressDay[]): SafeHtml {
  const oldestFirst = [...newestFirst].reverse();
  return chart({
    title: 'Discord link progress per day',
    kind: 'line',
    categoryLabel: 'Day',
    categories: oldestFirst.map((r) => r.day),
    series: [
      { label: 'Linked', values: oldestFirst.map((r) => r.linked) },
      { label: 'Unlinked', values: oldestFirst.map((r) => r.unlinked) },
      { label: 'Onboarding', values: oldestFirst.map((r) => r.onboarding) },
    ],
  });
}

export function registerLinkProgressRoutes(
  router: express.Router,
  deps: Pick<DashboardPageDeps, 'linkProgress'>,
): void {
  router.get(DASHBOARD_PATHS.linkProgress, (async (req, res) => {
    const days = parseDays(req.query.days);
    const page = parsePage(req.query.page);
    // At most 365 small rows: listDays is bounded, so slicing in memory is fine.
    const loaded = await load(res, WHAT, async () =>
      (await deps.linkProgress()).listDays(Number(days)),
    );
    if (!loaded.ok) {
      return;
    }
    const rows = loaded.value;
    if (!Array.isArray(rows) || !rows.every(isDayRow)) {
      unavailable(res, WHAT);
      return;
    }
    dashboardPage(res, {
      title: 'Link progress',
      body: html`<div class="card">
        <h1>Link progress</h1>
        ${rangeNav(days)}
        <p class="muted">
          Recorded once a day since the dashboard's build job started.
        </p>
        ${
          rows.length === 0
            ? html`<p>No link progress recorded yet.</p>`
            : html`${progressChart(rows)}${daysTable(rows, days, page)}`
        }
      </div>`,
    });
  }) as RequestHandler);
}

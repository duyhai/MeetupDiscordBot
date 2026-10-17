import express, { RequestHandler } from 'express';

import {
  DASHBOARD_PATHS,
  dashboardPath,
} from '../../lib/reports/dashboardPaths.js';
import {
  Period,
  comparePeriods,
  periodKey,
  periodOf,
  previousPeriod,
  suspensionCutoff,
} from '../../lib/reports/period.js';
import { LinkProgressDay } from '../../lib/repositories/postgresLinkProgressRepository.js';
import {
  SERIES_MAX_MONTHS,
  SnapshotMeta,
} from '../../lib/repositories/postgresReportSnapshotRepository.js';
import { chart } from '../charts.js';
import { SafeHtml, html, pageLink } from '../html.js';
import { dashboardPage, load } from '../pageKit.js';
import type { DashboardPageDeps } from './dashboardPages.js';

const WHAT = 'Trends';
const RANGES = {
  '12': 12,
  '24': 24,
  '60': 60,
  all: SERIES_MAX_MONTHS,
} as const;
type RangeChoice = keyof typeof RANGES;
const RANGE_CHOICES = Object.keys(RANGES) as RangeChoice[];
const DEFAULT_RANGE: RangeChoice = '24';
const RANGE_LABELS: Record<RangeChoice, string> = {
  '12': '12 months',
  '24': '24 months',
  '60': '5 years',
  all: 'All',
};
const MAX_LINK_DAYS = 1000;
const DAY = /^(\d{4}-\d{2})-\d{2}$/;

/** `?months=` when it is exactly one of the fixed choices (a plain string), else 24. */
function parseRange(value: unknown): RangeChoice {
  return RANGE_CHOICES.find((r) => r === value) ?? DEFAULT_RANGE;
}

const isPeriod = (p: unknown): p is Period =>
  typeof p === 'object' &&
  p !== null &&
  Number.isInteger((p as Period).year) &&
  Number.isInteger((p as Period).month) &&
  (p as Period).month >= 1 &&
  (p as Period).month <= 12;

/** `count` months ending with `last`, oldest first. */
function monthsEndingAt(last: Period, count: number): Period[] {
  const out: Period[] = [last];
  while (out.length < count) {
    out.unshift(previousPeriod(out[0]));
  }
  return out;
}

/** A read's rows, or none when the answer is not an array. */
function asList<T>(value: T[]): T[] {
  return Array.isArray(value) ? value : [];
}

/** Summary objects by month key. Rows without a valid period are skipped. */
function summariesByMonth(
  metas: SnapshotMeta[],
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  (Array.isArray(metas) ? metas : []).forEach((meta) => {
    if (meta && isPeriod(meta.period)) {
      const { summary } = meta;
      out.set(
        periodKey(meta.period),
        typeof summary === 'object' && summary !== null
          ? (summary as Record<string, unknown>)
          : {},
      );
    }
  });
  return out;
}

/** A stored count (summary field or link progress column): `Number(x) || 0`, never negative. */
function count(source: object | undefined, field: string): number {
  const value = (source as Record<string, unknown> | undefined)?.[field];
  return Math.max(0, Number(value) || 0);
}

/** The last recorded day of each month (listDays is newest first). */
function lastDayByMonth(days: LinkProgressDay[]): Map<string, LinkProgressDay> {
  const out = new Map<string, LinkProgressDay>();
  (Array.isArray(days) ? days : []).forEach((d) => {
    const month = typeof d?.day === 'string' ? DAY.exec(d.day)?.[1] : undefined;
    if (month !== undefined && !out.has(month)) {
      out.set(month, d);
    }
  });
  return out;
}

/** The categories: the fixed window, or for `all` from the earliest stored month (else the last 24). */
function categoriesFor(
  range: RangeChoice,
  window: Period[],
  stored: Period[],
): Period[] {
  if (range !== 'all') {
    return window;
  }
  const earliest = stored
    .filter((p) => comparePeriods(p, window[0]) >= 0)
    .sort(comparePeriods)[0];
  if (earliest === undefined) {
    return window.slice(-RANGES[DEFAULT_RANGE]);
  }
  return window.filter((p) => comparePeriods(p, earliest) >= 0);
}

function rangeNav(current: RangeChoice): SafeHtml {
  const path = dashboardPath(DASHBOARD_PATHS.trends);
  return html`<nav class="pager">
    ${RANGE_CHOICES.map((months) => {
      const label = RANGE_LABELS[months];
      if (months === current) {
        return html`<strong>${label}</strong>`;
      }
      return html`<a href="${pageLink(path, { months })}">${label}</a>`;
    })}
  </nav>`;
}

export function registerTrendsRoutes(
  router: express.Router,
  deps: Pick<
    DashboardPageDeps,
    'now' | 'snapshots' | 'suspensions' | 'linkProgress'
  >,
): void {
  router.get(DASHBOARD_PATHS.trends, (async (req, res) => {
    const range = parseRange(req.query.months);
    const months = RANGES[range];
    const window = monthsEndingAt(periodOf(deps.now()), months);
    // Summaries only (no payloads), suspension counts per month (at most one
    // row each) and at most 1000 small link progress rows.
    const loaded = await load(res, WHAT, async () => {
      const [snapshots, suspensions, linkProgress] = await Promise.all([
        deps.snapshots(),
        deps.suspensions(),
        deps.linkProgress(),
      ]);
      const [hallOfFame, noShows, suspended, days] = await Promise.all([
        snapshots.listSummarySeries('hall_of_fame', { months }),
        snapshots.listSummarySeries('no_show', { months }),
        // UTC midnight of the first month's first day: suspended_at's own
        // convention, from the one helper that defines that boundary.
        suspensions.countByMonth(suspensionCutoff(previousPeriod(window[0]))),
        linkProgress.listDays(Math.min(MAX_LINK_DAYS, months * 31)),
      ]);
      return { hallOfFame, noShows, suspended, days };
    });
    if (!loaded.ok) {
      return;
    }
    const { hallOfFame, noShows, suspended, days } = loaded.value;

    const stored = [...asList(hallOfFame), ...asList(noShows)]
      .map((m) => m?.period)
      .filter(isPeriod);
    const categories = categoriesFor(range, window, stored).map(periodKey);
    const hof = summariesByMonth(hallOfFame);
    const ns = summariesByMonth(noShows);
    const perMonth = new Map(
      asList(suspended).map((r) => [
        r?.month,
        Math.max(0, Number(r?.count) || 0),
      ]),
    );
    const links = lastDayByMonth(days);
    const series = (label: string, value: (month: string) => number) => ({
      label,
      values: categories.map(value),
    });

    const charts = [
      chart({
        title: 'No-shows per month',
        kind: 'bar',
        categories,
        series: [
          series('No-shows', (m) => count(ns.get(m), 'noShows')),
          series('Warnings', (m) => count(ns.get(m), 'warnings')),
          series('Suspension candidates', (m) =>
            count(ns.get(m), 'suspensionCandidates'),
          ),
        ],
      }),
      chart({
        title: 'Suspensions recorded per month',
        kind: 'bar',
        categories,
        series: [series('Suspensions', (m) => perMonth.get(m) ?? 0)],
      }),
      chart({
        title: 'Events and distinct hosts per month',
        kind: 'line',
        categories,
        series: [
          series('Events', (m) => count(hof.get(m), 'events')),
          series('Hosts', (m) => count(hof.get(m), 'hosts')),
        ],
      }),
      chart({
        title: 'New hosts per month',
        kind: 'bar',
        categories,
        series: [series('New hosts', (m) => count(hof.get(m), 'newHosts'))],
      }),
      chart({
        title: 'Link progress (last recorded day of each month)',
        kind: 'line',
        categories,
        series: [
          series('Linked', (m) => count(links.get(m), 'linked')),
          series('Unlinked', (m) => count(links.get(m), 'unlinked')),
        ],
      }),
    ];

    dashboardPage(res, {
      title: 'Trends',
      body: html`<div class="card">
        <h1>Trends</h1>
        ${rangeNav(range)}
        <p class="muted">
          Month by month from the stored reports. Months with no report show as
          0. Link progress is recorded once a day since the dashboard's build
          job started.
        </p>
        ${charts.map((c) => html`<section>${c}</section>`)}
      </div>`,
    });
  }) as RequestHandler);
}

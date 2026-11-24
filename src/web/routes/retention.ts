/**
 * /dashboard/retention: whether first-timers come back and how long members
 * stay, from the group snapshot (src/lib/retention/retention.ts has the
 * definitions). Staff only, like Trends. Counts and percentages only: no
 * member name or id is read or shown.
 */
import express, { RequestHandler } from 'express';

import {
  DASHBOARD_PATHS,
  dashboardPath,
} from '../../lib/reports/dashboardPaths.js';
import { monthLabel, parsePeriodKey } from '../../lib/reports/period.js';
import {
  FOLLOWING_YEARS,
  HeadlineTile,
  NINETY_DAYS,
  WINDOW_MONTHS,
  Rate,
  RetentionData,
  RetentionView,
  addMonths,
  headlines,
  isMatured,
  ladder,
  lastMatured,
  monthsBetween,
  percent,
  sumCohorts,
  thirdEventFollowUp,
  yearRows,
} from '../../lib/retention/retention.js';
import { chart } from '../charts.js';
import { SafeHtml, html, pageLink } from '../html.js';
import { dashboardPage, load, pacificDateTime } from '../pageKit.js';

const WHAT = 'Retention';
const RANGE_CHOICES = ['12', '24', '60', 'all'] as const;
type RangeChoice = (typeof RANGE_CHOICES)[number];
/** Months of first events, ending with the snapshot's month; all of them when undefined. */
const RANGES: Record<RangeChoice, number | undefined> = {
  '12': 12,
  '24': 24,
  '60': 60,
  all: undefined,
};
const DEFAULT_RANGE: RangeChoice = '24';
const RANGE_LABELS: Record<RangeChoice, string> = {
  '12': '12 months',
  '24': '24 months',
  '60': '5 years',
  all: 'All',
};

/** `?months=` when it is exactly one of the fixed choices (a plain string), else 24. */
function parseRange(value: unknown): RangeChoice {
  return RANGE_CHOICES.find((r) => r === value) ?? DEFAULT_RANGE;
}

function rangeNav(current: RangeChoice): SafeHtml {
  const path = dashboardPath(DASHBOARD_PATHS.retention);
  return html`<nav class="pager choices" aria-label="First events in">
    ${RANGE_CHOICES.map((months) => {
      const label = RANGE_LABELS[months];
      if (months === current) {
        return html`<strong>${label}</strong>`;
      }
      return html`<a href="${pageLink(path, { months })}">${label}</a>`;
    })}
  </nav>`;
}

/** 'August 2025' for '2025-08'; the key itself if it is not a month. */
function monthName(key: string): string {
  const period = parsePeriodKey(key);
  return period ? monthLabel(period) : key;
}

const whole = (n: number): string => n.toLocaleString('en-US');

/** '42%', or a dash with nobody to count. */
function share(rate: Rate): string {
  const value = percent(rate);
  return value === undefined ? '–' : `${value}%`;
}

/** '42% (181 of 431)'. */
function shareOf(rate: Rate): string {
  return rate.of > 0
    ? `${share(rate)} (${whole(rate.count)} of ${whole(rate.of)})`
    : '–';
}

/** 'July 2025 to June 2026', or the one month. */
function span(first: string, last: string): string {
  return first === last
    ? monthName(first)
    : `${monthName(first)} to ${monthName(last)}`;
}

function monthCount(n: number): string {
  return n === 1 ? '1 month' : `${n} months`;
}

/**
 * A headline tile. The line under the number names the months actually
 * counted: fewer than 12 when the data starts inside the window, and then
 * it says how many.
 */
function tile(label: string, t: HeadlineTile): SafeHtml {
  if (t.months === 0) {
    return html`<div class="stat">
      <dt>${label}</dt>
      <dd>–</dd>
      <dd class="stat-note">No first-timers have had the full time yet.</dd>
    </div>`;
  }
  function short(n: number): string {
    return n < WINDOW_MONTHS ? ` (${monthCount(n)} only)` : '';
  }
  const before =
    t.previousMonths === 0
      ? 'No earlier months to compare.'
      : `Before that, ${span(t.previousFirst, t.previousLast)}${short(t.previousMonths)}: ${shareOf(t.previous)}.`;
  return html`<div class="stat">
    <dt>${label}</dt>
    <dd>${share(t.rate)}</dd>
    <dd class="stat-note">
      ${whole(t.rate.count)} of ${whole(t.rate.of)} members whose first event
      was ${span(t.first, t.last)}${short(t.months)}. ${before}
    </dd>
  </div>`;
}

const section = (
  title: string,
  body: SafeHtml,
  note: SafeHtml | '' = '',
): SafeHtml =>
  html`<section>
    <h2 class="chart-title">${title}</h2>
    ${body}${note}
  </section>`;

const soFar = html` <span class="badge neutral">so far</span>`;

/**
 * The comparison under the ladder; nothing when either group is empty (no
 * month in the range has had its 270 days, or everyone is in one group).
 */
function followUpNote(f: ReturnType<typeof thirdEventFollowUp>): SafeHtml | '' {
  if (f.last === undefined || f.early.of === 0 || f.notEarly.of === 0) {
    return '';
  }
  return html`<p class="chart-note">
    An early third event goes with staying: of members whose first event was
    ${span(f.first, f.last)}, ${shareOf(f.early)} of those who attended a third
    event within 90 days of their first also attended an event 91 to 270 days
    after it, against ${shareOf(f.notEarly)} of those who did not reach a third
    event in 90 days. The two go together; this does not show that one causes
    the other.
  </p>`;
}

function body(view: RetentionView, range: RangeChoice): SafeHtml {
  const asOfMonth = view.asOf.slice(0, 7);
  const earliest = view.cohorts[0]?.month ?? asOfMonth;
  const months = RANGES[range];
  const first =
    months === undefined ? earliest : addMonths(asOfMonth, 1 - months);
  const matured = lastMatured(view.asOf, NINETY_DAYS);
  const tiles = headlines(view);

  // The ladder: first events in the range, matured months only.
  const steps = ladder(sumCohorts(view.cohorts, first, matured));
  const followUp = thirdEventFollowUp(view, first);
  const years = yearRows(view);

  // 90-day rates by month: matured months that had first-timers.
  const rateMonths = view.cohorts.filter(
    (c) =>
      c.month >= first &&
      c.members > 0 &&
      isMatured(c.month, view.asOf, NINETY_DAYS),
  );

  // Activity: every month of the range, zero where nobody attended.
  const activity = new Map(view.months.map((m) => [m.month, m]));
  const activityFirst =
    months === undefined ? (view.months[0]?.month ?? asOfMonth) : first;
  const activityMonths = monthsBetween(activityFirst, asOfMonth);

  return html`<div class="card">
    <h1>Retention</h1>
    <p class="muted">
      ${
        view.updatedAt
          ? `Updated ${pacificDateTime(view.updatedAt)} Pacific from the daily copy of the group’s events.`
          : ''
      }
      A member attended an event when they said yes to it and it has happened:
      Meetup’s no-show marks are not in this data. Cancelled events do not
      count. People who joined the group and never attended are not on this
      page.
    </p>
    <dl class="stats retention">
      ${tile('Third event within 90 days', tiles.third90)}
      ${tile('Second event within 90 days', tiles.second90)}
      ${tile('Still coming a year on', tiles.yearOn)}
    </dl>
    <p class="muted chart-note">
      Each number is for the latest 12 months of first-timers who have all had
      the full time (fewer months when the data does not go back that far): 90
      days after their first event for the first two, 365 days for the third.
      “Still coming a year on” is the share who attended an event roughly 9 to
      12 months after their first (days 271 to 365).
    </p>
    ${rangeNav(range)}
    <p class="muted">
      The charts below count members whose first event was in the chosen period.
    </p>
    ${section(
      'Share who came to another event, by events attended',
      chart({
        title: 'Share who came to another event, by events attended',
        kind: 'bar',
        unit: 'percent',
        categoryLabel: 'Events attended',
        categories: steps.map((s) => s.events),
        series: [
          {
            label: 'Came to another',
            // Nobody reached that many events: no bar, not a 0% one.
            values: steps.map((s) => percent(s.rate) ?? null),
          },
        ],
      }),
      html`<p class="muted chart-note">
          Of members who attended that many events, the share who went on to
          attend one more, at any time since. Counts members whose first event
          was ${span(first <= matured ? first : matured, matured)}. First-timers
          after ${monthName(matured)} are left out: not all of them have had 90
          days to come back.
        </p>
        ${followUpNote(followUp)}`,
    )}
    ${section(
      'The first steps, by first-event year',
      html`<div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>First event in</th>
              <th>Members</th>
              <th>Came to a second</th>
              <th>Second to third</th>
              <th>Third to fourth</th>
            </tr>
          </thead>
          <tbody>
            ${years.map(
              (y) =>
                html`<tr>
                  <td>${y.year}</td>
                  <td>${whole(y.members)}${y.filling ? soFar : ''}</td>
                  ${y.steps.map(
                    (s) => html`<td>${share(s)}${y.filling ? soFar : ''}</td>`,
                  )}
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`,
      html`<p class="muted chart-note">
        For members whose first event was in each year: the share who attended a
        second event, then of those the share who attended a third, then a
        fourth. Numbers marked “so far” are for a year that still has
        first-timers with less than 90 days behind them: they will change.
      </p>`,
    )}
    ${section(
      'Second and third event within 90 days, by first-event month',
      chart({
        title: 'Second and third event within 90 days, by first-event month',
        kind: 'line',
        unit: 'percent',
        categoryLabel: 'First event in',
        categories: rateMonths.map((c) => c.month),
        series: [
          {
            label: 'Second event',
            values: rateMonths.map(
              (c) => percent({ count: c.second90, of: c.members }) ?? 0,
            ),
          },
          {
            label: 'Third event',
            values: rateMonths.map(
              (c) => percent({ count: c.third90, of: c.members }) ?? 0,
            ),
          },
        ],
      }),
      html`<p class="muted chart-note">
        Of members whose first event was in each month, the share who attended a
        second event, and a third, within 90 days of the first. A month appears
        once all its first-timers have had the full 90 days; a month with no
        first-timers is left out.
      </p>`,
    )}
    ${section(
      'Members attending each month, new and returning',
      chart({
        title: 'Members attending each month, new and returning',
        kind: 'bar',
        categories: activityMonths,
        series: [
          {
            label: 'New',
            values: activityMonths.map(
              (m) => activity.get(m)?.firstTimers ?? 0,
            ),
          },
          {
            label: 'Returning',
            values: activityMonths.map((m) => {
              const row = activity.get(m);
              return row ? Math.max(0, row.active - row.firstTimers) : 0;
            }),
          },
        ],
      }),
      html`<p class="muted chart-note">
        Members who attended at least one event that month. New: it was their
        first event with the group. Returning: they had attended before. The
        latest month is still filling in.
      </p>`,
    )}
    ${section(
      'Yearly cohorts',
      html`<div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>First event in</th>
              <th>Members</th>
              <th>One event only</th>
              <th>Five or more</th>
              ${Array.from(
                { length: FOLLOWING_YEARS },
                (_unused, i) =>
                  html`<th>${i + 1} ${i === 0 ? 'year' : 'years'} later</th>`,
              )}
            </tr>
          </thead>
          <tbody>
            ${years.map(
              (y) =>
                html`<tr>
                  <td>${y.year}</td>
                  <td>${whole(y.members)}${y.filling ? soFar : ''}</td>
                  <td>${share(y.oneOnly)}${y.filling ? soFar : ''}</td>
                  <td>${share(y.fiveOrMore)}${y.filling ? soFar : ''}</td>
                  ${y.following.map((f) => {
                    if (f.state === 'future') {
                      return html`<td></td>`;
                    }
                    return html`<td>
                      ${share(f.rate)}${f.state === 'so-far' ? soFar : ''}
                    </td>`;
                  })}
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`,
      html`<p class="muted chart-note">
        Each row is the members whose first event was in that year. “One event
        only” and “Five or more” count every event they have attended since. “1
        year later” is the share who attended at least one event in the next
        calendar year, and so on. A year that is not over, and the newest year’s
        own numbers, are marked “so far”.
      </p>`,
    )}
  </div>`;
}

export function registerRetentionRoutes(
  router: express.Router,
  deps: { retention: () => Promise<RetentionData> },
): void {
  router.get(DASHBOARD_PATHS.retention, (async (req, res) => {
    const range = parseRange(req.query.months);
    const loaded = await load(res, WHAT, () => deps.retention());
    if (!loaded.ok) {
      return;
    }
    const data = loaded.value;
    if (!data.ready) {
      dashboardPage(res, {
        title: 'Retention',
        body: html`<div class="card">
          <h1>Retention</h1>
          <p>
            Nothing to show yet. This page fills in once the first full copy of
            the group’s events has finished.
          </p>
        </div>`,
      });
      return;
    }
    dashboardPage(res, { title: 'Retention', body: body(data, range) });
  }) as RequestHandler);
}

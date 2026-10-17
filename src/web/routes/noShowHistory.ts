import express, { RequestHandler } from 'express';

import {
  DASHBOARD_PATHS,
  dashboardPath,
  memberHistoryPath,
  monthPath,
} from '../../lib/reports/dashboardPaths.js';
import { noShowsMissing } from '../../lib/reports/meetupMonth.js';
import {
  Period,
  isFinished,
  monthLabel,
  parsePeriodKey,
  periodKey,
} from '../../lib/reports/period.js';
import {
  AttendanceEvidence,
  EventRef,
  MemberRef,
  NoShowCasePayload,
  NoShowPayload,
} from '../../lib/reports/types.js';
import { MemberNoShowMonth } from '../../lib/repositories/postgresReportSnapshotRepository.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html, localUrl, pageLink } from '../html.js';
import { eventLink, memberHistoryLink, memberLink } from '../links.js';
import {
  builtByHtml,
  dashboardPage,
  load,
  notFound,
  pacificDate,
  pacificDateTime,
  parseRouteMonth,
  unavailable,
  zeroNoShowNote,
} from '../pageKit.js';
import { PAGE_SIZE, pageNav, parsePage } from '../paging.js';
import type { DashboardPageDeps } from './dashboardPages.js';
import { refreshForm, refreshNotice } from './refresh.js';

const WHAT = 'The no-show report';
const MEMBER_WHAT = "This member's no-show history";
/** The same rule as memberHistoryPath and the repository: checked here so a bad id never reaches a query. */
const MEMBER_ID = /^[0-9]{1,20}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

const isArrayOf = (v: unknown, each: (x: unknown) => boolean): boolean =>
  Array.isArray(v) && v.every(each);

/** A counted event: its date must be a string, or the page would show a wrong one. */
const isCountedEvent = (e: unknown): boolean =>
  isObject(e) && typeof e.dateTime === 'string';

/** Only the two reasons the build writes: an unknown one is not shown as "12 months". */
const isSince = (s: unknown): boolean =>
  isObject(s) &&
  typeof s.day === 'string' &&
  (s.reason === 'twelve-months' || s.reason === 'last-suspension');

const isCase = (c: unknown): boolean =>
  isObject(c) &&
  isObject(c.member) &&
  isArrayOf(c.counted, isCountedEvent) &&
  isSince(c.since);

const isCleared = (c: unknown): boolean => isObject(c) && isObject(c.member);

/** A stored payload this page can render; anything else is the 503 page, never a 500. */
const isNoShow = (p: unknown): p is NoShowPayload =>
  isObject(p) &&
  p.reportType === 'no_show' &&
  typeof p.asOf === 'string' &&
  isArrayOf(p.cases, isCase) &&
  isArrayOf(p.cleared, isCleared) &&
  isArrayOf(p.departed, isObject) &&
  (p.attendance === undefined ||
    p.attendance === null ||
    isObject(p.attendance));

const count = (value: unknown): number => Number(value) || 0;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function classificationLabel(
  c: Pick<NoShowCasePayload, 'classification'>,
): string {
  return c.classification === 'suspension' ? 'Suspension candidate' : 'Warning';
}

const SINCE_LABELS = {
  'twelve-months': '12 months',
  'last-suspension': 'last suspension',
} as const;

/** Counted no-shows, oldest first: each event linked only if safeHref accepts its URL. */
function countedList(counted: EventRef[]): SafeHtml {
  return html`<ul>
    ${counted.map(
      (e) =>
        html`<li>
          ${eventLink(e)}
          <span class="muted">${pacificDate(e.dateTime)}</span>
        </li>`,
    )}
  </ul>`;
}

/** A member link plus, for an all-digit id, the link to their history page. */
function memberCell(member: { id: unknown; name: unknown }): SafeHtml {
  const history = memberHistoryLink(member.id);
  return html`${memberLink(member)}${
    history ? html` <a href="${history}">History</a>` : ''
  }`;
}

function caseRow(c: NoShowCasePayload): SafeHtml {
  // isNoShow admitted only the two known reasons.
  const { since } = c;
  const reason = SINCE_LABELS[since.reason];
  return html`<tr>
    <td>${memberCell(c.member)}</td>
    <td>${classificationLabel(c)}</td>
    <td>
      ${c.counted.length} ${countedList(c.counted)}
      <span class="muted">Counted since ${asText(since.day)} (${reason})</span>
    </td>
    <td>${count(c.priorSuspensions)}</td>
    <td>${count(c.recommendedDays)} days</td>
    <td>${c.hostedPastEvent === true ? 'Has hosted' : ''}</td>
  </tr>`;
}

/**
 * formatNoShowReport's order: every warning, then every suspension
 * candidate, each group in stored order (filter keeps it stable).
 */
function commandOrder(cases: NoShowCasePayload[]): NoShowCasePayload[] {
  return [
    ...cases.filter((c) => c.classification !== 'suspension'),
    ...cases.filter((c) => c.classification === 'suspension'),
  ];
}

function casesTable(
  payload: NoShowPayload,
  period: Period,
  page: number,
): SafeHtml {
  if (payload.cases.length === 0) {
    return html`<p>No member has a no-show case this month.</p>`;
  }
  const start = (page - 1) * PAGE_SIZE;
  const rows = commandOrder(payload.cases).slice(start, start + PAGE_SIZE);
  return html`<table>
      <thead>
        <tr>
          <th>Member</th>
          <th>Status</th>
          <th>Counted no-shows</th>
          <th>Prior suspensions</th>
          <th>Next suspension</th>
          <th>Hosting</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(caseRow)}
      </tbody>
    </table>
    ${pageNav(
      monthPath(DASHBOARD_PATHS.noShowHistoryMonth, period),
      page,
      start + PAGE_SIZE < payload.cases.length,
    )}`;
}

/** The first 50 entries, then "and N more": never the whole list. */
function shortList<T>(
  items: T[],
  row: (item: T) => SafeHtml,
  empty: string,
): SafeHtml {
  if (items.length === 0) {
    return html`<p class="muted">${empty}</p>`;
  }
  const more = items.length - PAGE_SIZE;
  return html`<ul>
      ${items.slice(0, PAGE_SIZE).map((item) => html`<li>${row(item)}</li>`)}
    </ul>
    ${more > 0 ? html`<p class="muted">and ${more} more</p>` : ''}`;
}

/** The command's wording: the suspension day, else "older than 12 months". */
const clearedRow = (c: NoShowPayload['cleared'][number]): SafeHtml => {
  const day = asText(c.lastSuspendedDay);
  return html`${memberCell(c.member)}
    <span class="muted"
      >${day ? `suspended ${day}` : 'older than 12 months'}</span
    >`;
};

const departedRow = (m: MemberRef): SafeHtml => memberCell(m);

/** listSummaries' attendance, checked: a malformed stored value is no evidence. */
function evidence(value: unknown): AttendanceEvidence | undefined {
  return isObject(value) ? (value as unknown as AttendanceEvidence) : undefined;
}

/** One month's status for one member, from their own row. */
function memberStatus(row: MemberNoShowMonth): string {
  const labels: string[] = [];
  if (isObject(row.noShowCase)) {
    labels.push(classificationLabel(row.noShowCase));
  }
  if (row.cleared) {
    labels.push('No action needed — no-shows no longer count');
  }
  if (row.departed) {
    labels.push('Left the group');
  }
  return labels.join('; ');
}

function memberCounted(row: MemberNoShowMonth): EventRef[] {
  return isObject(row.noShowCase) && Array.isArray(row.noShowCase.counted)
    ? row.noShowCase.counted.filter(isObject)
    : [];
}

export function registerNoShowHistoryRoutes(
  router: express.Router,
  deps: Pick<DashboardPageDeps, 'now' | 'snapshots'>,
): void {
  router.get(DASHBOARD_PATHS.noShowHistory, (async (req, res) => {
    const before =
      typeof req.query.before === 'string'
        ? parsePeriodKey(req.query.before)
        : undefined;
    const loaded = await load(res, 'The no-show reports', async () =>
      (await deps.snapshots()).listSummaries('no_show', {
        before,
        limit: PAGE_SIZE,
      }),
    );
    if (!loaded.ok) {
      return;
    }
    const now = deps.now();
    const metas = loaded.value;
    const last = metas[metas.length - 1];
    const older =
      metas.length === PAGE_SIZE && last
        ? html`<nav class="pager">
            <a
              href="${pageLink(dashboardPath(DASHBOARD_PATHS.noShowHistory), {
                before: periodKey(last.period),
              })}"
              >Older months</a
            >
          </nav>`
        : '';
    const table =
      metas.length === 0
        ? html`<p>No no-show reports have been built yet.</p>`
        : html`<table>
            <thead>
              <tr>
                <th>Month</th>
                <th>No-show RSVPs</th>
                <th>Members</th>
                <th>Warnings</th>
                <th>Suspension candidates</th>
                <th>Cleared</th>
                <th>Left the group</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              ${metas.map((meta) => {
                const s = (meta.summary ?? {}) as Record<string, unknown>;
                const att = evidence(meta.attendance);
                const missing =
                  isFinished(meta.period, now) &&
                  att !== undefined &&
                  noShowsMissing(att);
                return html`<tr>
                  <td>
                    <a
                      href="${localUrl(
                        monthPath(
                          DASHBOARD_PATHS.noShowHistoryMonth,
                          meta.period,
                        ),
                      )}"
                      >${monthLabel(meta.period)}</a
                    >
                  </td>
                  <td>${count(s.noShows)}</td>
                  <td>${count(s.members)}</td>
                  <td>${count(s.warnings)}</td>
                  <td>${count(s.suspensionCandidates)}</td>
                  <td>${count(s.cleared)}</td>
                  <td>${count(s.departed)}</td>
                  <td>${missing ? 'No no-shows recorded' : ''}</td>
                </tr>`;
              })}
            </tbody>
          </table>`;
    dashboardPage(res, {
      title: 'No-show history',
      body: html`<div class="card">
        <h1>No-show history</h1>
        ${table} ${older}
      </div>`,
    });
  }) as RequestHandler);

  // Registered before the month route only for readability: '/members/:id'
  // has two segments, so ':period' can never match it.
  router.get(DASHBOARD_PATHS.noShowHistoryMember, (async (req, res) => {
    const memberId = req.params.memberId;
    if (typeof memberId !== 'string' || !MEMBER_ID.test(memberId)) {
      notFound(res);
      return;
    }
    const page = parsePage(req.query.page);
    const loaded = await load(res, MEMBER_WHAT, async () =>
      (await deps.snapshots()).listMemberNoShowMonths(memberId, {
        offset: (page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      }),
    );
    if (!loaded.ok) {
      return;
    }
    const rows = loaded.value;
    const caseName = rows.find(
      (r) => isObject(r.noShowCase) && isObject(r.noShowCase.member),
    )?.noShowCase?.member.name;
    const name = asText(caseName) || `Member ${memberId}`;
    const path = memberHistoryPath(memberId);
    if (path === undefined) {
      notFound(res);
      return;
    }
    const pager = pageNav(path, page, rows.length === PAGE_SIZE);
    const table =
      rows.length === 0
        ? page > 1
          ? html`<p>No more months.</p>
              ${pager}`
          : html`<p>No stored no-show report mentions this member.</p>`
        : html`<table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Status</th>
                  <th>Counted no-shows</th>
                  <th>As of</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map((row) => {
                  const counted = memberCounted(row);
                  return html`<tr>
                    <td>
                      <a
                        href="${localUrl(
                          monthPath(
                            DASHBOARD_PATHS.noShowHistoryMonth,
                            row.period,
                          ),
                        )}"
                        >${monthLabel(row.period)}</a
                      >
                    </td>
                    <td>${memberStatus(row)}</td>
                    <td>${counted.length > 0 ? countedList(counted) : ''}</td>
                    <td>As of ${pacificDateTime(row.asOf)} Pacific</td>
                  </tr>`;
                })}
              </tbody>
            </table>
            ${pager}`;
    dashboardPage(res, {
      title: 'No-show history for a member',
      body: html`<div class="card">
        <h1>No-show history — ${memberLink({ id: memberId, name })}</h1>
        ${table}
      </div>`,
    });
  }) as RequestHandler);

  router.get(DASHBOARD_PATHS.noShowHistoryMonth, (async (req, res) => {
    const now = deps.now();
    const period = parseRouteMonth(req.params.period, now);
    if (period === undefined) {
      notFound(res);
      return;
    }
    const loaded = await load(res, WHAT, async () =>
      (await deps.snapshots()).getCurrent('no_show', period),
    );
    if (!loaded.ok) {
      return;
    }
    const { session } = dashboardLocals(res);
    const snapshot = loaded.value;
    const label = monthLabel(period);
    const head = html`<h1>No-show history — ${label}</h1>
      ${refreshNotice(req.query.refresh)}`;
    const refresh = refreshForm(period, session.csrfToken, 'no-show-history');
    if (!snapshot) {
      dashboardPage(res, {
        title: `No-show history ${label}`,
        body: html`<div class="card">
          ${head}
          <p>The ${label} reports have not been built yet.</p>
          ${refresh}
        </div>`,
      });
      return;
    }
    if (!isNoShow(snapshot.payload)) {
      unavailable(res, WHAT);
      return;
    }
    const payload = snapshot.payload;
    const s = (isObject(payload.summary) ? payload.summary : {}) as Record<
      string,
      unknown
    >;
    dashboardPage(res, {
      title: `No-show history ${label}`,
      body: html`<div class="card">
          ${head}
          <p class="muted">
            Counts no-shows up to ${pacificDateTime(payload.asOf)} Pacific.
            Built ${pacificDateTime(snapshot.builtAt)} Pacific by
            ${builtByHtml(snapshot.builtBy)}.
          </p>
          ${zeroNoShowNote(period, evidence(payload.attendance), now)}
          <p>
            ${count(s.noShows)} no-show RSVPs · ${count(s.members)} members ·
            ${count(s.warnings)} warnings · ${count(s.suspensionCandidates)}
            suspension candidates · ${count(s.cleared)} cleared ·
            ${count(s.departed)} left the group
          </p>
          ${refresh}
        </div>
        <div class="card">
          <h2>Cases</h2>
          ${casesTable(payload, period, parsePage(req.query.page))}
        </div>
        <div class="card">
          <h2>No action needed — this month's no-shows no longer count</h2>
          ${shortList(payload.cleared, clearedRow, 'Nobody was cleared.')}
        </div>
        <div class="card">
          <h2>Left the group</h2>
          ${shortList(payload.departed, departedRow, 'Nobody left the group.')}
        </div>`,
    });
  }) as RequestHandler);
}

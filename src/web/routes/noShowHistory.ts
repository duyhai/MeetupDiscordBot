import express, { RequestHandler } from 'express';

import {
  DASHBOARD_PATHS,
  dashboardPath,
  linkableMonthPath,
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
import { isWorkspaceMonth } from '../../lib/workspace/months.js';
import { STATUS_LABELS } from '../../lib/workspace/service.js';
import { WorkspaceStatus } from '../../lib/workspace/types.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html, localUrl, pageLink } from '../html.js';
import { eventLink, memberHistoryLink, memberLink } from '../links.js';
import {
  monthCell,
  builtByHtml,
  dashboardPage,
  load,
  loadOptional,
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
/**
 * The workspace outcomes are an optional column: a hung read gives up at
 * 5 s, so it adds at most that to a page whose own read already has
 * PAGE_LOAD_DEADLINE_MS, well under Heroku's 30 s.
 */
export const HISTORY_OUTCOMES_DEADLINE_MS = 5000;
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

/**
 * A stored payload this page can render; anything else is the 503 page,
 * never a 500. The workspace page uses the same guard for its cases.
 */
export const isNoShowPayload = (p: unknown): p is NoShowPayload =>
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

/**
 * Workspace statuses for an Outcome column: undefined when the month (or
 * every listed month) is before the workspace, so there is no column;
 * { ok: false } when the read failed, so every cell is "—".
 */
type Outcomes =
  { ok: true; value: Map<string, WorkspaceStatus> } | { ok: false } | undefined;

/** Fixed text only: an unknown stored status is "Unknown", never its own text. */
function outcomeLabel(status: WorkspaceStatus): string {
  return Object.hasOwn(STATUS_LABELS, status)
    ? STATUS_LABELS[status]
    : 'Unknown';
}

function outcomeHeader(outcomes: Outcomes): SafeHtml | '' {
  if (outcomes === undefined) {
    return '';
  }
  return outcomes.ok
    ? html`<th>Outcome</th>`
    : html`<th>Outcome (unavailable)</th>`;
}

/** The status under `key` (a member id or a month key), linked to the month's workspace; "—" when there is none. */
function outcomeCell(outcomes: Outcomes, key: unknown, period: Period) {
  if (outcomes === undefined) {
    return '';
  }
  const status =
    outcomes.ok && typeof key === 'string'
      ? outcomes.value.get(key)
      : undefined;
  if (status === undefined) {
    return html`<td data-label="Outcome">—</td>`;
  }
  const path = linkableMonthPath(DASHBOARD_PATHS.workspaceMonth, period);
  const label = outcomeLabel(status);
  return path === undefined
    ? html`<td data-label="Outcome">${label}</td>`
    : html`<td data-label="Outcome">
        <a href="${localUrl(path)}">${label}</a>
      </td>`;
}

function caseRow(
  c: NoShowCasePayload,
  outcomes: Outcomes,
  period: Period,
): SafeHtml {
  // isNoShow admitted only the two known reasons.
  const { since } = c;
  const reason = SINCE_LABELS[since.reason];
  return html`<tr>
    <td data-label="Member">${memberCell(c.member)}</td>
    <td data-label="Status">${classificationLabel(c)}</td>
    <td data-label="Counted no-shows">
      ${c.counted.length} ${countedList(c.counted)}
      <span class="muted">Counted since ${asText(since.day)} (${reason})</span>
    </td>
    <td data-label="Prior suspensions">${count(c.priorSuspensions)}</td>
    <td data-label="Next suspension">${count(c.recommendedDays)} days</td>
    <td data-label="Hosting">
      ${c.hostedPastEvent === true ? 'Has hosted' : ''}
    </td>
    ${outcomeCell(outcomes, c.member.id, period)}
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

/** One page of cases, in the command's order. */
function casesPage(payload: NoShowPayload, page: number): NoShowCasePayload[] {
  const start = (page - 1) * PAGE_SIZE;
  return commandOrder(payload.cases).slice(start, start + PAGE_SIZE);
}

function casesTable(
  payload: NoShowPayload,
  period: Period,
  page: number,
  rows: NoShowCasePayload[],
  outcomes: Outcomes,
): SafeHtml {
  if (payload.cases.length === 0) {
    return html`<p>No member has a no-show case this month.</p>`;
  }
  const start = (page - 1) * PAGE_SIZE;
  return html`<table class="stack">
      <thead>
        <tr>
          <th>Member</th>
          <th>Status</th>
          <th>Counted no-shows</th>
          <th>Prior suspensions</th>
          <th>Next suspension</th>
          <th>Hosting</th>
          ${outcomeHeader(outcomes)}
        </tr>
      </thead>
      <tbody>
        ${rows.map((c) => caseRow(c, outcomes, period))}
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
  deps: Pick<DashboardPageDeps, 'now' | 'snapshots' | 'workspace'>,
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
        ? html`<nav class="pager" aria-label="Older months">
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
        : html`<table class="stack">
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
                  <td data-label="Month">
                    ${monthCell(DASHBOARD_PATHS.noShowHistoryMonth, meta.period)}
                  </td>
                  <td data-label="No-show RSVPs">${count(s.noShows)}</td>
                  <td data-label="Members">${count(s.members)}</td>
                  <td data-label="Warnings">${count(s.warnings)}</td>
                  <td data-label="Suspension candidates">
                    ${count(s.suspensionCandidates)}
                  </td>
                  <td data-label="Cleared">${count(s.cleared)}</td>
                  <td data-label="Left the group">${count(s.departed)}</td>
                  <td data-label="Note">
                    ${missing ? 'No no-shows recorded' : ''}
                  </td>
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
    // In parallel with the history read; loadOptional never rejects.
    const outcomesRead = loadOptional(
      'workspace outcomes',
      async () => (await deps.workspace()).statusesForMember(memberId),
      HISTORY_OUTCOMES_DEADLINE_MS,
    );
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
    const now = deps.now();
    // Months before the workspace never show an outcome; with none listed, no column.
    const outcomes: Outcomes = rows.some((r) => isWorkspaceMonth(r.period, now))
      ? await outcomesRead
      : undefined;
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
        : html`<table class="stack">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Status</th>
                  <th>Counted no-shows</th>
                  <th>As of</th>
                  ${outcomeHeader(outcomes)}
                </tr>
              </thead>
              <tbody>
                ${rows.map((row) => {
                  const counted = memberCounted(row);
                  return html`<tr>
                    <td data-label="Month">
                      ${monthCell(DASHBOARD_PATHS.noShowHistoryMonth, row.period)}
                    </td>
                    <td data-label="Status">${memberStatus(row)}</td>
                    <td data-label="Counted no-shows">
                      ${counted.length > 0 ? countedList(counted) : ''}
                    </td>
                    <td data-label="As of">
                      As of ${pacificDateTime(row.asOf)} Pacific
                    </td>
                    ${
                      outcomes === undefined
                        ? ''
                        : isWorkspaceMonth(row.period, now)
                          ? outcomeCell(
                              outcomes,
                              periodKey(row.period),
                              row.period,
                            )
                          : html`<td data-label="Outcome"></td>`
                    }
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
    if (!isNoShowPayload(snapshot.payload)) {
      unavailable(res, WHAT);
      return;
    }
    const payload = snapshot.payload;
    const page = parsePage(req.query.page);
    const pageCases = casesPage(payload, page);
    // Only months in the workspace range, only this page's members.
    const outcomes: Outcomes =
      isWorkspaceMonth(period, now) && pageCases.length > 0
        ? await loadOptional(
            'workspace outcomes',
            async () =>
              (await deps.workspace()).statusesByMember(
                period,
                pageCases
                  .map((c) => c.member.id)
                  .filter((id): id is string => typeof id === 'string'),
              ),
            HISTORY_OUTCOMES_DEADLINE_MS,
          )
        : undefined;
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
          ${casesTable(payload, period, page, pageCases, outcomes)}
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

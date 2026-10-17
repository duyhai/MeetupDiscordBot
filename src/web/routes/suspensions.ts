import express, { RequestHandler } from 'express';

import { pacificToday, utcDateOnly } from '../../lib/helpers/suspensionList.js';
import {
  DASHBOARD_PATHS,
  dashboardPath,
} from '../../lib/reports/dashboardPaths.js';
import {
  SuspensionPageRow,
  SuspensionState,
} from '../../lib/repositories/postgresSuspensionRepository.js';
import { SafeHtml, html, memberText, pageLink } from '../html.js';
import { discordUserLink, memberHistoryLink, memberLink } from '../links.js';
import {
  dashboardPage,
  load,
  pacificDateTime,
  unavailable,
} from '../pageKit.js';
import { PAGE_SIZE, pageNav, parsePage } from '../paging.js';
import type { DashboardPageDeps } from './dashboardPages.js';

const WHAT = 'Suspension records';
const STATES: readonly SuspensionState[] = ['active', 'past', 'voided'];
const TAB_LABELS: Record<SuspensionState, string> = {
  active: 'Active',
  past: 'Past',
  voided: 'Voided',
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `?state=` when it is one of the three tabs (a plain string), else active. */
function parseState(value: unknown): SuspensionState {
  return STATES.find((s) => s === value) ?? 'active';
}

const isValidDate = (v: unknown): v is Date =>
  v instanceof Date && !Number.isNaN(v.getTime());

/** Text columns: a string, null, or absent. */
const isOptionalText = (v: unknown): boolean =>
  v === null || v === undefined || typeof v === 'string';

const TEXT_FIELDS = [
  'notes',
  'voidReason',
  'memberName',
  'linkedName',
  'voidedBy',
  'linkedDiscordId',
] as const;

/**
 * A row this tab can render; anything else is the 503 page, never a 500. A
 * voided-tab row must carry a valid void time.
 */
function isPageRow(
  row: unknown,
  state: SuspensionState,
): row is SuspensionPageRow {
  if (typeof row !== 'object' || row === null) {
    return false;
  }
  const r = row as Record<string, unknown>;
  return (
    Number.isSafeInteger(r.id) &&
    typeof r.memberId === 'string' &&
    isValidDate(r.suspendedAt) &&
    Number.isSafeInteger(r.durationDays) &&
    typeof r.lastDay === 'string' &&
    DAY.test(r.lastDay) &&
    (state === 'voided'
      ? isValidDate(r.voidedAt)
      : r.voidedAt === null ||
        r.voidedAt === undefined ||
        isValidDate(r.voidedAt)) &&
    TEXT_FIELDS.every((field) => isOptionalText(r[field]))
  );
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Stored name (at suspension time), then the members table, then the id. Never a live Meetup lookup. */
function memberCell(row: SuspensionPageRow): SafeHtml {
  const name = text(row.memberName) || text(row.linkedName) || row.memberId;
  const history = memberHistoryLink(row.memberId);
  return html`${memberLink({ id: row.memberId, name })}${
    row.linkedDiscordId
      ? html` · ${discordUserLink(row.linkedDiscordId, 'Discord')}`
      : ''
  }${history ? html` · <a href="${history}">No-show history</a>` : ''}`;
}

function recordRow(row: SuspensionPageRow, voided: boolean): SafeHtml {
  return html`<tr>
    <td>#${row.id}</td>
    <td>${memberCell(row)}</td>
    <td>${utcDateOnly(row.suspendedAt)} through ${row.lastDay}</td>
    <td>${row.durationDays} days</td>
    <td>${row.notes ? memberText(row.notes) : ''}</td>
    ${
      voided
        ? html`<td>${pacificDateTime(row.voidedAt ?? '')} Pacific</td>
            <td>${discordUserLink(row.voidedBy, 'moderator')}</td>
            <td>${row.voidReason ? memberText(row.voidReason) : ''}</td>`
        : ''
    }
  </tr>`;
}

function tabs(
  current: SuspensionState,
  counts: Record<SuspensionState, number>,
): SafeHtml {
  const path = dashboardPath(DASHBOARD_PATHS.suspensions);
  return html`<nav class="pager">
    ${STATES.map((state) => {
      const label = `${TAB_LABELS[state]} (${Number(counts[state]) || 0})`;
      return state === current
        ? html`<strong>${label}</strong>`
        : html`<a href="${pageLink(path, { state })}">${label}</a>`;
    })}
  </nav>`;
}

function recordsTable(
  state: SuspensionState,
  rows: SuspensionPageRow[],
  page: number,
): SafeHtml {
  const pager = pageNav(
    dashboardPath(DASHBOARD_PATHS.suspensions),
    page,
    rows.length === PAGE_SIZE,
    { state },
  );
  if (rows.length === 0) {
    return page > 1
      ? html`<p>No more records.</p>
          ${pager}`
      : html`<p>No ${TAB_LABELS[state].toLowerCase()} suspensions.</p>`;
  }
  const voided = state === 'voided';
  return html`<table>
      <thead>
        <tr>
          <th>Record</th>
          <th>Member</th>
          <th>Suspended</th>
          <th>Length</th>
          <th>Notes</th>
          ${
            voided
              ? html`<th>Voided</th>
                  <th>Voided by</th>
                  <th>Reason</th>`
              : ''
          }
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => recordRow(row, voided))}
      </tbody>
    </table>
    ${pager}`;
}

export function registerSuspensionRoutes(
  router: express.Router,
  deps: Pick<DashboardPageDeps, 'now' | 'suspensions'>,
): void {
  router.get(DASHBOARD_PATHS.suspensions, (async (req, res) => {
    const state = parseState(req.query.state);
    const page = parsePage(req.query.page);
    const today = pacificToday(deps.now());
    const loaded = await load(res, WHAT, async () => {
      const reader = await deps.suspensions();
      const [counts, rows] = await Promise.all([
        reader.countByState(today),
        reader.listPage({
          state,
          today,
          offset: (page - 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
        }),
      ]);
      return { counts, rows };
    });
    if (!loaded.ok) {
      return;
    }
    const { counts, rows } = loaded.value;
    if (!Array.isArray(rows) || !rows.every((row) => isPageRow(row, state))) {
      unavailable(res, WHAT);
      return;
    }
    dashboardPage(res, {
      title: 'Suspension records',
      body: html`<div class="card">
        <h1>Suspension records</h1>
        ${tabs(state, counts)}
        ${
          state === 'active'
            ? html`<p class="muted">
                Same split as /meetup_list_suspensions: active through the last
                suspended day, Pacific time.
              </p>`
            : ''
        }
        ${
          state === 'voided'
            ? html`<p class="muted">
                Voided records are kept as the audit trail. They no longer
                count, and /meetup_list_suspensions does not show them.
              </p>`
            : ''
        }
        ${recordsTable(state, rows, page)}
      </div>`,
    });
  }) as RequestHandler);
}

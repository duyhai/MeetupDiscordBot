import express, { Request, RequestHandler, Response } from 'express';

import { pacificToday, utcDateOnly } from '../../lib/helpers/suspensionList.js';
import {
  DASHBOARD_PATHS,
  dashboardPath,
} from '../../lib/reports/dashboardPaths.js';
import {
  SuspensionPageRow,
  SuspensionState,
} from '../../lib/repositories/postgresSuspensionRepository.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html, memberText, pageLink } from '../html.js';
import { discordUserLink, memberHistoryLink, memberLink } from '../links.js';
import {
  dashboardPage,
  load,
  pacificDateTime,
  unavailable,
} from '../pageKit.js';
import { PAGE_SIZE, pageNav, parsePage } from '../paging.js';
import { bannedTabBody, isBanRow, parseBanShow } from './bannedTab.js';
import type { DashboardPageDeps } from './dashboardPages.js';

const WHAT = 'Suspension records';
const STATES: readonly SuspensionState[] = ['active', 'past', 'voided'];
const TAB_LABELS: Record<SuspensionState, string> = {
  active: 'Active',
  past: 'Past',
  voided: 'Voided',
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A Suspensions page tab: the three record tabs, or the Banned tab. */
type SuspensionTab = SuspensionState | 'banned';

/**
 * `?state=`: 'banned' is its own branch (the Banned tab); otherwise one of
 * the three record tabs (a plain string), else active.
 */
function parseState(value: unknown): SuspensionTab {
  if (value === 'banned') {
    return 'banned';
  }
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
    <td data-label="Record">#${row.id}</td>
    <td data-label="Member">${memberCell(row)}</td>
    <td data-label="Suspended">
      ${utcDateOnly(row.suspendedAt)} through ${row.lastDay}
    </td>
    <td data-label="Length">${row.durationDays} days</td>
    <td data-label="Notes">${row.notes ? memberText(row.notes) : ''}</td>
    ${
      voided
        ? html`<td data-label="Voided">
              ${pacificDateTime(row.voidedAt ?? '')} Pacific
            </td>
            <td data-label="Voided by">
              ${discordUserLink(row.voidedBy, 'moderator')}
            </td>
            <td data-label="Reason">
              ${row.voidReason ? memberText(row.voidReason) : ''}
            </td>`
        : ''
    }
  </tr>`;
}

function tabs(
  current: SuspensionTab,
  counts: Record<SuspensionState, number>,
  activeBans: number,
): SafeHtml {
  const path = dashboardPath(DASHBOARD_PATHS.suspensions);
  const entries: { tab: SuspensionTab; label: string }[] = [
    ...STATES.map((state) => ({
      tab: state,
      label: `${TAB_LABELS[state]} (${Number(counts[state]) || 0})`,
    })),
    { tab: 'banned', label: `Banned (${Number(activeBans) || 0})` },
  ];
  return html`<nav class="pager choices" aria-label="Suspension records">
    ${entries.map(({ tab, label }) => {
      return tab === current
        ? html`<strong>${label}</strong>`
        : html`<a href="${pageLink(path, { state: tab })}">${label}</a>`;
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
  return html`<table class="stack">
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

type SuspensionRouteDeps = Pick<
  DashboardPageDeps,
  'now' | 'suspensions' | 'bans'
>;

/**
 * The Banned tab: the suspension list is not read, only its counts for the
 * other tab labels.
 */
async function bannedTab(
  req: Request,
  res: Response,
  deps: SuspensionRouteDeps,
  page: number,
  today: string,
): Promise<void> {
  const show = parseBanShow(req.query.show);
  const loaded = await load(res, 'Bans', async () => {
    const [reader, bans] = await Promise.all([deps.suspensions(), deps.bans()]);
    const [counts, banCounts, rows] = await Promise.all([
      reader.countByState(today),
      bans.countByState(),
      bans.listPage({
        state: show,
        offset: (page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      }),
    ]);
    return { counts, banCounts, rows };
  });
  if (!loaded.ok) {
    return;
  }
  const { counts, banCounts, rows } = loaded.value;
  if (!Array.isArray(rows) || !rows.every((row) => isBanRow(row, show))) {
    unavailable(res, 'Bans');
    return;
  }
  dashboardPage(res, {
    title: 'Suspension records',
    body: html`<div class="card">
      <h1>Suspension records</h1>
      ${tabs('banned', counts, banCounts.active)}
      ${bannedTabBody({
        show,
        rows,
        counts: banCounts,
        page,
        notice: '',
        // Task 5 decides who sees the forms.
        leader: false,
        csrf: dashboardLocals(res).session.csrfToken,
      })}
    </div>`,
  });
}

export function registerSuspensionRoutes(
  router: express.Router,
  deps: SuspensionRouteDeps,
): void {
  router.get(DASHBOARD_PATHS.suspensions, (async (req, res) => {
    const state = parseState(req.query.state);
    const page = parsePage(req.query.page);
    const today = pacificToday(deps.now());
    if (state === 'banned') {
      await bannedTab(req, res, deps, page, today);
      return;
    }
    const loaded = await load(res, WHAT, async () => {
      const [reader, bans] = await Promise.all([
        deps.suspensions(),
        deps.bans(),
      ]);
      const [counts, banCounts, rows] = await Promise.all([
        reader.countByState(today),
        bans.countByState(),
        reader.listPage({
          state,
          today,
          offset: (page - 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
        }),
      ]);
      return { counts, banCounts, rows };
    });
    if (!loaded.ok) {
      return;
    }
    const { counts, banCounts, rows } = loaded.value;
    if (!Array.isArray(rows) || !rows.every((row) => isPageRow(row, state))) {
      unavailable(res, WHAT);
      return;
    }
    dashboardPage(res, {
      title: 'Suspension records',
      body: html`<div class="card">
        <h1>Suspension records</h1>
        ${tabs(state, counts, banCounts.active)}
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

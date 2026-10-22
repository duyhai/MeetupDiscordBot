import express, { RequestHandler, Response } from 'express';
import { BanState } from '../../lib/bans/types.js';

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
  loadOptional,
  pacificDateTime,
  unavailable,
} from '../pageKit.js';
import { PAGE_SIZE, pageNav, parsePage } from '../paging.js';
import {
  banResultNotice,
  bannedTabBody,
  isBanRow,
  parseBanShow,
} from './bannedTab.js';
import type { DashboardPageDeps } from './dashboardPages.js';
import { LeadershipDisplayCache } from './workspace.js';
import { leadershipOf } from './workspaceActions.js';

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

/** 'Label (n)', or the bare label when the count could not be read. */
function tabLabel(label: string, count: number | undefined): string {
  return count === undefined ? label : `${label} (${Number(count) || 0})`;
}

/**
 * The tab nav. Each side's counts are optional: one store being down never
 * takes the other's tabs with it, it only drops those counts.
 */
function tabs(
  current: SuspensionTab,
  counts: Record<SuspensionState, number> | undefined,
  activeBans: number | undefined,
): SafeHtml {
  const path = dashboardPath(DASHBOARD_PATHS.suspensions);
  const entries: { tab: SuspensionTab; label: string }[] = [
    ...STATES.map((state) => ({
      tab: state,
      label: tabLabel(TAB_LABELS[state], counts?.[state]),
    })),
    { tab: 'banned', label: tabLabel('Banned', activeBans) },
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
  'now' | 'suspensions' | 'bans' | 'isLeadership'
>;

/** What one render of the Banned tab shows besides the rows it reads. */
export interface BannedTabRender {
  show: BanState;
  page: number;
  notice: SafeHtml | '';
  /** Whether to show the forms: a display answer, never the authority. */
  leader: Promise<boolean> | boolean;
  status?: number;
}

/**
 * The Banned tab: the ban rows and counts under the page deadline (a
 * failure is the 503 page); the suspension counts for the other tab labels
 * are optional, so a suspension outage only drops them. The suspension
 * list itself is never read here.
 */
export async function renderBannedTab(
  res: Response,
  deps: Pick<DashboardPageDeps, 'now' | 'suspensions' | 'bans'>,
  view: BannedTabRender,
): Promise<void> {
  const { show, page } = view;
  const today = pacificToday(deps.now());
  const [loaded, suspensionCounts, leader] = await Promise.all([
    load(res, 'Bans', async () => {
      const bans = await deps.bans();
      const [banCounts, rows] = await Promise.all([
        bans.countByState(),
        bans.listPage({
          state: show,
          offset: (page - 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
        }),
      ]);
      return { banCounts, rows };
    }),
    loadOptional('Suspension counts', async () =>
      (await deps.suspensions()).countByState(today),
    ),
    view.leader,
  ]);
  if (!loaded.ok) {
    return;
  }
  const { banCounts, rows } = loaded.value;
  const counts = suspensionCounts.ok ? suspensionCounts.value : undefined;
  if (!Array.isArray(rows) || !rows.every((row) => isBanRow(row, show))) {
    unavailable(res, 'Bans');
    return;
  }
  dashboardPage(res, {
    title: 'Suspension records',
    ...(view.status !== undefined && { status: view.status }),
    // The photo forms' script, only where they render (Leadership, display).
    ...(leader && show === 'active' && { script: 'bans' as const }),
    body: html`<div class="card">
      <h1>Suspension records</h1>
      ${tabs('banned', counts, banCounts.active)}
      ${bannedTabBody({
        show,
        rows,
        counts: banCounts,
        page,
        notice: view.notice,
        leader,
        csrf: dashboardLocals(res).session.csrfToken,
        today,
      })}
    </div>`,
  });
}

export function registerSuspensionRoutes(
  router: express.Router,
  deps: SuspensionRouteDeps,
): void {
  // As the workspace month page: a cached live answer (up to 60 s) decides
  // only whether the Banned tab shows its forms. Every ban POST asks
  // Discord live.
  const displayLeadership = new LeadershipDisplayCache(() =>
    deps.now().getTime(),
  );
  router.get(DASHBOARD_PATHS.suspensions, (async (req, res) => {
    const state = parseState(req.query.state);
    const page = parsePage(req.query.page);
    const today = pacificToday(deps.now());
    if (state === 'banned') {
      const { session } = dashboardLocals(res);
      await renderBannedTab(res, deps, {
        show: parseBanShow(req.query.show),
        page,
        notice: banResultNotice(req.query.result),
        // leadershipOf never rejects.
        leader: displayLeadership
          .get(session.userId, () =>
            leadershipOf(deps.isLeadership, session.userId),
          )
          .then((answer) => answer === 'leader'),
      });
      return;
    }
    const [loaded, banCounts] = await Promise.all([
      load(res, WHAT, async () => {
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
      }),
      // Outside load: a bans outage only drops the Banned count.
      loadOptional('Ban counts', async () =>
        (await deps.bans()).countByState(),
      ),
    ]);
    if (!loaded.ok) {
      return;
    }
    const { counts, rows } = loaded.value;
    const activeBans = banCounts.ok ? banCounts.value.active : undefined;
    if (!Array.isArray(rows) || !rows.every((row) => isPageRow(row, state))) {
      unavailable(res, WHAT);
      return;
    }
    dashboardPage(res, {
      title: 'Suspension records',
      body: html`<div class="card">
        <h1>Suspension records</h1>
        ${tabs(state, counts, activeBans)}
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

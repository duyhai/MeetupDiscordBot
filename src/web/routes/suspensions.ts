import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import { pacificToday, utcDateOnly } from '../../lib/helpers/suspensionList.js';
import {
  DASHBOARD_BASE,
  DASHBOARD_PATHS,
  dashboardPath,
} from '../../lib/reports/dashboardPaths.js';
import {
  SuspensionDateEdit,
  SuspensionPageRow,
  SuspensionState,
} from '../../lib/repositories/postgresSuspensionRepository.js';
import {
  DateEditCode,
  FIRST_SUSPENSION_DAY,
} from '../../lib/suspensions/dateEdit.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html, localUrl, memberText, pageLink } from '../html.js';
import { discordUserLink, memberHistoryLink, memberLink } from '../links.js';
import { loadStaffNames, staffLink } from '../staffNames.js';
import {
  dashboardPage,
  load,
  loadOptional,
  parseRowId,
  notFound,
  pacificDate,
  pacificDateTime,
  unavailable,
} from '../pageKit.js';
import { PAGE_SIZE, pageNav, parsePage } from '../paging.js';
import { confirmModal } from '../ui/modal.js';
import { bannedTabPath } from './bannedTab.js';
import type { DashboardPageDeps } from './dashboardPages.js';
import { LeadershipDisplayCache } from './workspace.js';
import { leadershipOf, withDeadline } from './workspaceActions.js';

const logger = new Logger({ name: 'dashboard' });

const WHAT = 'Suspension records';
const STATES: readonly SuspensionState[] = ['active', 'past', 'voided'];
const TAB_LABELS: Record<SuspensionState, string> = {
  active: 'Active',
  past: 'Past',
  voided: 'Voided',
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `?state=`: one of the three record tabs (a plain string), else active. */
function parseState(value: unknown): SuspensionState {
  return STATES.find((s) => s === value) ?? 'active';
}

/** '/dashboard/suspensions/12/date': only for a record id from 1 to 2^31-1. Throws RangeError. */
export function suspensionDatePath(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1 || id > 2 ** 31 - 1) {
    throw new RangeError('suspensionDatePath needs a record id');
  }
  return `${DASHBOARD_BASE}${DASHBOARD_PATHS.suspensionDate.replace(':id', String(id))}`;
}

/** Fixed text per Edit date result. Nothing from the request is echoed. */
export const DATE_EDIT_MESSAGES = {
  'date-changed':
    'Date changed. The length and end date were worked out again, and the old date is kept on the record.',
  'date-unchanged': 'That is already the date. Nothing changed.',
  'not-live': 'That suspension is voided or no longer exists. Nothing changed.',
  'date-taken':
    'This member already has another suspension on that date. Nothing changed.',
  overlaps:
    'On that date this suspension would overlap another of this member’s suspensions. Nothing changed.',
  reorders:
    'Another suspension sits between the old and new dates; void and re-record instead. Nothing changed.',
  'linked-month':
    'This suspension is linked to a no-show workspace card, and that date is ' +
    'outside the card’s month. Void it on the card and record it again to ' +
    'move it to another month.',
  'bad-date': `The date must be a real date from ${FIRST_SUSPENSION_DAY} through today.`,
  invalid:
    'That request could not be understood. Reload the page and try again.',
  error: 'That did not save. Please try again in a minute.',
  'not-leadership':
    'Only the 1.5 Leadership Team can change a suspension date. Nothing changed.',
  'leadership-unavailable':
    'Discord could not be reached to check your role. Nothing changed; try again in a minute.',
} as const satisfies Record<
  DateEditCode | 'not-leadership' | 'leadership-unavailable',
  string
>;

export type DateEditResult = keyof typeof DATE_EDIT_MESSAGES;

export const isDateEditResult = (code: unknown): code is DateEditResult =>
  typeof code === 'string' && Object.hasOwn(DATE_EDIT_MESSAGES, code);

function dateEditNotice(code: unknown): SafeHtml | '' {
  if (!isDateEditResult(code)) {
    return '';
  }
  return code === 'date-changed'
    ? html`<p class="note info">${DATE_EDIT_MESSAGES[code]}</p>`
    : html`<p class="note attn">${DATE_EDIT_MESSAGES[code]}</p>`;
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

/** One date fix, as the record shows it. */
function editLine(
  edit: SuspensionDateEdit,
  names: Readonly<Record<string, string>>,
): SafeHtml {
  return html`<li>
    Was ${edit.oldDay} (${edit.oldDurationDays} days), changed to ${edit.newDay}
    (${edit.newDurationDays} days) by ${staffLink(edit.editedBy, names)} on
    ${pacificDate(edit.editedAt)}
  </li>`;
}

interface RowView {
  voided: boolean;
  names: Readonly<Record<string, string>>;
  edits: ReadonlyMap<number, SuspensionDateEdit[]>;
  /** The Edit date pop-up's form, or undefined (not Leadership, or voided). */
  editForm: ((row: SuspensionPageRow) => SafeHtml) | undefined;
}

function recordRow(row: SuspensionPageRow, view: RowView): SafeHtml {
  const { voided, names } = view;
  const edits = view.edits.get(row.id) ?? [];
  return html`<tr>
    <td data-label="Record" class="rec-short">#${row.id}</td>
    <td data-label="Member" class="rec-member">${memberCell(row)}</td>
    <td data-label="Suspended" class="rec-dates">
      <span class="nowrap">${utcDateOnly(row.suspendedAt)}</span> through
      <span class="nowrap">${row.lastDay}</span>
      ${
        row.dateEstimated === true
          ? html`<span class="badge attn">Date not recorded</span>`
          : ''
      }
      ${
        edits.length > 0
          ? html`<ul class="rec-edits muted">
              ${edits.map((e) => editLine(e, names))}
            </ul>`
          : ''
      }
      ${
        view.editForm
          ? html`<div class="rec-actions">${view.editForm(row)}</div>`
          : ''
      }
    </td>
    <td data-label="Length" class="rec-short">${row.durationDays} days</td>
    <td data-label="Notes" class="rec-text">
      ${row.notes ? memberText(row.notes) : ''}
    </td>
    ${
      voided
        ? html`<td data-label="Voided" class="rec-when">
              ${pacificDateTime(row.voidedAt ?? '')} Pacific
            </td>
            <td data-label="Voided by" class="rec-who">
              ${staffLink(row.voidedBy, names)}
            </td>
            <td data-label="Reason" class="rec-text">
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

/** The three record tabs. Bans have their own page (Member moderation → Banned). */
function tabs(
  current: SuspensionState,
  counts: Record<SuspensionState, number> | undefined,
): SafeHtml {
  const path = dashboardPath(DASHBOARD_PATHS.suspensions);
  return html`<nav class="pager choices" aria-label="Suspension records">
    ${STATES.map((tab) => {
      const label = tabLabel(TAB_LABELS[tab], counts?.[tab]);
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
  view: RowView,
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
  const { voided } = view;
  return html`<table class="stack records">
      <thead>
        <tr>
          <th class="rec-short">Record</th>
          <th class="rec-member">Member</th>
          <th class="rec-dates">Suspended</th>
          <th class="rec-short">Length</th>
          <th class="rec-text">Notes</th>
          ${
            voided
              ? html`<th class="rec-when">Voided</th>
                  <th class="rec-who">Voided by</th>
                  <th class="rec-text">Reason</th>`
              : ''
          }
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => recordRow(row, view))}
      </tbody>
    </table>
    ${pager}`;
}

const EDIT_DATE_TIP =
  'Fixes the date this suspension starts. The length and end date are ' +
  'worked out again from the member’s other live suspensions before the new ' +
  'date, as when recording. The old date, the new one, you and the time are ' +
  'kept on the record and posted to the moderation log. Other suspensions ' +
  'are not changed: a date that passes another suspension, or overlaps ' +
  'one, is refused. Nothing changes on Meetup.';

/** The Edit date pop-up for one live record: Leadership only (display; the POST asks Discord live). */
function editDateForm(
  row: SuspensionPageRow,
  state: SuspensionState,
  csrf: string,
  today: string,
): SafeHtml {
  return confirmModal({
    trigger: { label: 'Edit date', tone: 'ghost' },
    title: `Change the date of suspension #${row.id}`,
    tip: EDIT_DATE_TIP,
    action: localUrl(suspensionDatePath(row.id)),
    fields: html`<input type="hidden" name="_csrf" value="${csrf}" />
      <input type="hidden" name="state" value="${state}" />
      <label class="field"
        >Suspended from
        <input
          type="date"
          name="date"
          value="${utcDateOnly(row.suspendedAt)}"
          min="${FIRST_SUSPENSION_DAY}"
          max="${today}"
          required
      /></label>`,
    confirmLabel: 'Change the date',
    tone: 'primary',
  });
}

type SuspensionRouteDeps = Pick<
  DashboardPageDeps,
  'now' | 'suspensions' | 'isLeadership' | 'staffNames' | 'suspensionActions'
>;

/** How long Edit date's service call may run before the route answers 'error'. */
export const DATE_EDIT_DEADLINE_MS = 20_000;

export function registerSuspensionRoutes(
  router: express.Router,
  deps: SuspensionRouteDeps,
): void {
  // As the workspace month page: a cached live answer (up to 60 s) decides
  // only whether rows offer Edit date. The POST asks Discord live.
  const displayLeadership = new LeadershipDisplayCache(() =>
    deps.now().getTime(),
  );
  router.get(DASHBOARD_PATHS.suspensions, (async (req, res) => {
    // The Banned tab moved to its own page (Member moderation → Banned):
    // old links and bookmarks land there, with only the known parameters.
    if (req.query.state === 'banned') {
      // 302: a moved page, but not promised forever. Only the known
      // parameters go along (show=lifted, a valid page).
      const show = req.query.show === 'lifted' ? 'lifted' : undefined;
      const page = parsePage(req.query.page);
      const target = bannedTabPath(show ? { show } : {});
      res.redirect(
        302,
        page > 1
          ? `${target}${target.includes('?') ? '&' : '?'}page=${page}`
          : target,
      );
      return;
    }
    const state = parseState(req.query.state);
    const page = parsePage(req.query.page);
    const today = pacificToday(deps.now());
    const { session } = dashboardLocals(res);
    // leadershipOf never rejects.
    const leadership =
      state === 'voided'
        ? Promise.resolve(false)
        : displayLeadership
            .get(session.userId, () =>
              leadershipOf(deps.isLeadership, session.userId),
            )
            .then((answer) => answer === 'leader');
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
      await leadership;
      return;
    }
    const { counts, rows } = loaded.value;
    if (!Array.isArray(rows) || !rows.every((row) => isPageRow(row, state))) {
      await leadership;
      unavailable(res, WHAT);
      return;
    }
    // Optional: a failing read only hides the "was …" lines.
    const edits = await loadOptional('Suspension date edits', async () =>
      (await deps.suspensions()).listDateEdits(rows.map((r) => r.id)),
    );
    const editMap = edits.ok ? edits.value : new Map<number, never[]>();
    const staffNames = await loadStaffNames(deps.staffNames, [
      ...rows.map((r) => r.voidedBy),
      ...[...editMap.values()].flat().map((e) => e.editedBy),
    ]);
    const leader = await leadership;
    const csrf = session.csrfToken;
    dashboardPage(res, {
      title: 'Suspension records',
      body: html`<div class="card">
        <h1>Suspension records</h1>
        ${dateEditNotice(req.query.result)} ${tabs(state, counts)}
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
        ${recordsTable(state, rows, page, {
          voided: state === 'voided',
          names: staffNames,
          edits: editMap,
          editForm: leader
            ? (row) => editDateForm(row, state, csrf, today)
            : undefined,
        })}
      </div>`,
    });
  }) as RequestHandler);

  // POST /dashboard/suspensions/:id/date: Leadership's date fix. CSRF,
  // Origin, Sec-Fetch-Site and the per-user rate limit are the router's
  // unsafe-method guard; the Leadership check is live, every time.
  router.post(DASHBOARD_PATHS.suspensionDate, (async (req, res) => {
    const id = parseRowId(req.params.id);
    if (id === undefined) {
      notFound(res);
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const tab = body?.state === 'past' ? 'past' : 'active';
    const back = (code: DateEditResult) =>
      res.redirect(
        303,
        `${dashboardPath(DASHBOARD_PATHS.suspensions)}?state=${tab}&result=${code}`,
      );
    const { session } = dashboardLocals(res);
    const answer = await leadershipOf(deps.isLeadership, session.userId);
    if (answer !== 'leader') {
      back(
        answer === 'not-leader' ? 'not-leadership' : 'leadership-unavailable',
      );
      return;
    }
    if (Array.isArray(body?.date)) {
      back('invalid');
      return;
    }
    try {
      const result = await withDeadline(DATE_EDIT_DEADLINE_MS, () =>
        deps.suspensionActions.editDate({
          // Always the session's user, never a form field.
          actor: session.userId,
          id,
          date: body?.date,
          leadershipConfirmed: true,
        }),
      );
      back(result.code);
    } catch (error: unknown) {
      logger.warn(
        `Dashboard suspension date edit failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      back('error');
    }
  }) as RequestHandler);
}

import dayjs from 'dayjs';
import express, { RequestHandler, Response } from 'express';

import { recommendedSuspensionDays } from '../../lib/helpers/noShowReport.js';
import {
  lastSuspendedDay,
  pacificToday,
} from '../../lib/helpers/suspensionList.js';
import {
  DASHBOARD_PATHS,
  monthPath,
  workspaceRowPath,
} from '../../lib/reports/dashboardPaths.js';
import {
  Period,
  comparePeriods,
  monthLabel,
  periodDate,
  periodKey,
} from '../../lib/reports/period.js';
import { NoShowCasePayload } from '../../lib/reports/types.js';
import { SuspensionRecordState } from '../../lib/repositories/postgresSuspensionRepository.js';
import { SuspensionRecord } from '../../lib/repositories/types.js';
import { linkWindow, workspaceMonths } from '../../lib/workspace/months.js';
import {
  ACTION_TITLES,
  STATUS_LABELS,
  validateActionFields,
} from '../../lib/workspace/service.js';
import {
  feeDollars,
  recordedSuspensionMessage,
  suspensionMessage,
  warningMessage,
} from '../../lib/workspace/templates.js';
import {
  LEADERSHIP_ONLY_ACTIONS,
  allowedActions,
} from '../../lib/workspace/transitions.js';
import {
  BAN_BLOCKED_ACTIONS,
  DONE_STATUSES,
  NOTES_MAX,
  OPEN_STATUSES,
  PARKED_STATUSES,
  VOID_REASON_MAX,
  WORKSPACE_ACTIONS,
  WorkspaceAction,
  WorkspaceEvent,
  WorkspaceRow,
  WorkspaceStatus,
} from '../../lib/workspace/types.js';
import { UpcomingEntry, actByFor } from '../../lib/workspace/upcoming.js';
import { dashboardLocals } from '../dashboardRouter.js';
import { SafeHtml, html, localUrl, memberText, staticHtml } from '../html.js';
import {
  discordUserLink,
  eventLink,
  meetupProfileUrl,
  memberLink,
} from '../links.js';
import {
  builtByHtml,
  dashboardPage,
  load,
  loadOptional,
  monthCell,
  notFound,
  pacificDate,
  pacificDateTime,
  parseRowId,
  parseWorkspaceMonth,
} from '../pageKit.js';
import { PAGE_SIZE, pageNav, parsePage } from '../paging.js';
import type { DashboardPageDeps } from './dashboardPages.js';
import { isNoShowPayload } from './noShowHistory.js';
import { refreshForm, refreshNotice } from './refresh.js';
import {
  LeadershipAnswer,
  WORKSPACE_RESULT_MESSAGES,
  leadershipOf,
  workspaceResultNotice,
} from './workspaceActions.js';

const WHAT = 'The no-show workspace';
/** The months list counts at most this many months (statusCounts is one query per call). */
const LIST_MONTHS = 24;

const UNREACHABLE_NOTE =
  'Discord could not be reached to check your role, so recording, linking and voiding suspensions are hidden. Reload in a minute.';

/** The sync's event actions, in the history's words. */
const SYNC_ACTION_TITLES: Readonly<Record<string, string>> = {
  sync_created: 'Added from the report',
  sync_reclassified: 'Reclassified',
  sync_dropped: 'Dropped from the report',
  sync_returned: 'Back in the report',
};

const isWorkspaceAction = (value: string): value is WorkspaceAction =>
  (WORKSPACE_ACTIONS as readonly string[]).includes(value);

/** Fixed text only: an unknown stored action is "Updated", never its own text. */
function actionTitle(action: string): string {
  if (isWorkspaceAction(action)) {
    return ACTION_TITLES[action];
  }
  return Object.hasOwn(SYNC_ACTION_TITLES, action)
    ? SYNC_ACTION_TITLES[action]
    : 'Updated';
}

function statusLabel(status: WorkspaceStatus): string {
  return Object.hasOwn(STATUS_LABELS, status)
    ? STATUS_LABELS[status]
    : 'Unknown';
}

/**
 * A status as a badge. The colour is a literal class picked by status:
 * coral for a card nobody has acted on, blurple for one in progress or
 * suspended, green for a warning sent, grey for the rest (and anything
 * unknown).
 */
export function statusBadge(status: WorkspaceStatus): SafeHtml {
  const label = statusLabel(status);
  switch (status) {
    case 'new':
      return html`<span class="badge attn">${label}</span>`;
    case 'warning_copied':
    case 'suspended':
      return html`<span class="badge info">${label}</span>`;
    case 'warning_sent':
      return html`<span class="badge ok">${label}</span>`;
    default:
      return html`<span class="badge neutral">${label}</span>`;
  }
}

/** UTC midnight of a YYYY-MM-DD: how suspension dates are stored. */
const utcMidnight = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** Dated in the card's link window: what the action's SQL links from, so the page offers only what the POST takes. */
function inLinkWindow(r: SuspensionRecord, period: Period): boolean {
  const { from, until } = linkWindow(period);
  return r.suspendedAt >= from && r.suspendedAt < until;
}

/** A stored suspension date (UTC midnight) as 'Sep 20, 2026', never shifted a day by the timezone. */
const recordDay = (value: Date): string =>
  dayjs.utc(value).format('MMM D, YYYY');

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** Live records dated before `day` (a UTC midnight): what a suspension dated then counts (countSuspensionsBefore). */
const priorBefore = (records: SuspensionRecord[], day: Date): number =>
  records.filter((r) => r.suspendedAt < day).length;

/** Live records dated before today: what the next suspension's length counts. */
function priorCount(records: SuspensionRecord[], now: Date): number {
  return priorBefore(records, utcMidnight(pacificToday(now)));
}

/**
 * The earliest date the confirm page offers: the later of the month's 1st
 * and the day after the last day of any of the member's live records, so a
 * shown date is never before a live record (out-of-order) nor inside one
 * (overlap). `through` is that last day when it sets the min. The POST's
 * own checks stay the authority.
 */
function earliestDay(
  records: SuspensionRecord[],
  period: Period,
): { min: string; through?: string } {
  const first = periodDate(period);
  // YYYY-MM-DD sorts as dates: the last is the latest last day.
  const through = records
    .map((r) => lastSuspendedDay(r))
    .sort()
    .at(-1);
  if (through === undefined) {
    return { min: first };
  }
  const after = dayjs.utc(through).add(1, 'day').format('YYYY-MM-DD');
  return after > first ? { min: after, through } : { min: first };
}

/** The member's latest live record by date, for the out-of-order notice. */
function latestRecord(
  records: SuspensionRecord[],
): SuspensionRecord | undefined {
  let latest: SuspensionRecord | undefined;
  for (const r of records) {
    if (latest === undefined || r.suspendedAt > latest.suspendedAt) {
      latest = r;
    }
  }
  return latest;
}

/**
 * The confirm page's suspension date: `?date=` when the record step itself
 * would take it (validateActionFields: YYYY-MM-DD, a real day, from the 1st
 * through today) and it is not before `min` (earliestDay), else today.
 * Always rebuilt from the parsed date, so the query text never reaches the
 * page.
 */
function chosenDay(
  query: unknown,
  period: Period,
  now: Date,
  min: string,
): string {
  const checked = validateActionFields(
    'record_suspension',
    { version: '1', date: query },
    period,
    now,
  );
  const day =
    checked.ok && checked.fields.suspendedOn
      ? dayjs.utc(checked.fields.suspendedOn).format('YYYY-MM-DD')
      : undefined;
  return day !== undefined && day >= min ? day : pacificToday(now);
}

/** The suspension a card's message and length line describe. */
interface CardSuspension {
  /** True when it is the card's live linked record, not the next one. */
  recorded: boolean;
  /** Live records strictly before it: what its length and fee count. */
  prior: number;
  days: number;
  /** YYYY-MM-DD, its first day. */
  suspendedOn: string;
}

/**
 * A card with a live linked record describes that record: its own date and
 * length, and the fee counted from the live records before it. Otherwise the
 * next suspension, starting today.
 */
function cardSuspension(v: CardView): CardSuspension {
  const r = v.linked;
  if (r && r.voidedAt === null) {
    return {
      recorded: true,
      prior: v.records.filter((x) => x.suspendedAt < r.suspendedAt).length,
      days: r.durationDays,
      suspendedOn: dayjs.utc(r.suspendedAt).format('YYYY-MM-DD'),
    };
  }
  const prior = priorCount(v.records, v.now);
  return {
    recorded: false,
    prior,
    days: recommendedSuspensionDays(prior),
    suspendedOn: pacificToday(v.now),
  };
}

interface CardView {
  row: WorkspaceRow;
  csrf: string;
  now: Date;
  /** The row's case in the latest stored report, when that report could be read. */
  noShowCase: NoShowCasePayload | undefined;
  /** The member's live suspension records (listByMemberIds). */
  records: SuspensionRecord[];
  /** The linked record's live state, voided included. */
  linked: SuspensionRecordState | undefined;
  upcoming: UpcomingEntry | undefined;
  events: WorkspaceEvent[];
  /** Records that already back some workspace row (linkedRecordIds): never offered for linking. */
  linkedElsewhere: ReadonlySet<number>;
  /** The session holds the 1.5 Leadership Team role (live, or cached up to 60 s: display only). */
  leader: boolean;
  /** The member has an active ban: no suspension actions (applyAction refuses them too). */
  banned: boolean;
  /** The bans read answered. When false, no card offers record or link and none shows Banned. */
  banStatusKnown: boolean;
}

function caseBody(v: CardView): SafeHtml | '' {
  const c = v.noShowCase;
  if (!c) {
    return '';
  }
  const s = cardSuspension(v);
  const fee =
    c.hostedPastEvent === true
      ? 'has hosted, so no admin fee'
      : `plus a $${feeDollars(s.prior)} admin fee to rejoin`;
  return html`<p>Counted no-shows: ${c.counted.length}</p>
    <ul>
      ${c.counted.map(
        (e) =>
          html`<li>
            ${eventLink(e)}
            <span class="muted">${pacificDate(e.dateTime)}</span>
          </li>`,
      )}
    </ul>
    <p>
      Earlier suspensions: ${s.prior} ·
      ${s.recorded ? 'This suspension' : 'Next suspension'}: ${s.days} days
      (${fee})
    </p>`;
}

function upcomingBody(entry: UpcomingEntry | undefined, now: Date) {
  if (entry === undefined) {
    return '';
  }
  switch (entry.state) {
    case 'left':
      return html`<p>Left the group.</p>`;
    case 'pending':
      return html`<p class="muted">
        Still loading upcoming RSVPs from Meetup — reload in a minute.
      </p>`;
    case 'unavailable':
      return html`<p class="muted">Meetup unavailable, try again later.</p>`;
    default:
      break;
  }
  if (entry.events.length === 0) {
    return html`<p>No upcoming RSVPs.</p>`;
  }
  const act = actByFor(entry, now);
  return html`<p>Upcoming RSVPs:</p>
    <ul>
      ${entry.events.map(
        (e) =>
          html`<li>
            ${eventLink(e)}
            <span class="muted">${pacificDateTime(e.dateTime)}</span>${
              e.payment ? html` 💵 ${memberText(e.payment)}` : ''
            }
          </li>`,
      )}
    </ul>
    ${
      act
        ? html`<p>Act by ${act.actBy}${act.actNow ? ' — act now' : ''}</p>`
        : ''
    }`;
}

function suspensionBody(v: CardView): SafeHtml | '' {
  const r = v.linked;
  if (!r) {
    return '';
  }
  const span = html`<p>
    Suspension #${r.id}, ${r.durationDays} days from ${recordDay(r.suspendedAt)}
    through ${recordDay(utcMidnight(lastSuspendedDay(r)))}
  </p>`;
  if (r.voidedAt === null) {
    return span;
  }
  return html`${span}
    <p class="note">
      Voided ${pacificDateTime(r.voidedAt)} by
      ${discordUserLink(r.voidedBy, 'staff member')}:
      ${memberText(r.voidReason ?? '')}
    </p>`;
}

function copyBox(text: string, label: string): SafeHtml {
  // RCDATA: escaped text, never an attribute or a script.
  const box = html`<textarea class="copy" readonly rows="8">${text}</textarea>`;
  return html`<div data-copy-box>
    ${box}<button type="button" data-copy-near>${label}</button>
  </div>`;
}

/**
 * A suspended card: the suspension message of its live linked record, never
 * a warning, whatever the classification or report says now. Recording a
 * suspension on the open month changes what the next build counts, which
 * can reclassify the card as a warning or drop it from the report, so the
 * message reads only the record (its date and length) and the live records
 * before it (the fee), never the rebuilt case's no-shows. Without a live
 * record (voided outside the workspace, not yet followed) there is nothing
 * to send.
 */
function suspendedMessageBody(v: CardView): SafeHtml {
  const s = cardSuspension(v);
  if (!s.recorded) {
    return html`<p class="muted">Suspended — see the record above.</p>`;
  }
  const c = v.noShowCase;
  let text: string;
  try {
    text = recordedSuspensionMessage({
      memberName: v.row.memberName,
      priorSuspensions: s.prior,
      // Only the latest report says who hosted; without the case, the fee stays.
      hostWaiver: c?.hostedPastEvent === true,
      suspendedOn: s.suspendedOn,
      durationDays: s.days,
    });
  } catch {
    return html`<p class="muted">Suspended — see the record above.</p>`;
  }
  const unchecked = c
    ? ''
    : html`<p class="note attn">
        This member is not in the latest report, so hosting could not be
        checked. If they have hosted, remove the admin fee sentence.
      </p>`;
  return html`${unchecked}${copyBox(text, 'Copy suspension message')}`;
}

function messageBody(
  v: CardView,
  form: (action: WorkspaceAction, inner: SafeHtml, box?: boolean) => SafeHtml,
  actions: Set<WorkspaceAction>,
): SafeHtml | '' {
  if (v.row.status === 'suspended') {
    return suspendedMessageBody(v);
  }
  if (v.row.status === 'voided') {
    return html`<p class="muted">Voided — no message to send.</p>`;
  }
  const c = v.noShowCase;
  if (!c || !v.row.inLatestSnapshot) {
    return '';
  }
  const s = cardSuspension(v);
  const hostWaiver = c.hostedPastEvent === true;
  let text: string;
  try {
    text =
      v.row.classification === 'warning'
        ? warningMessage({
            memberName: v.row.memberName,
            event: c.counted[0],
            // A warning always speaks of the next suspension.
            priorSuspensions: priorCount(v.records, v.now),
            hostWaiver,
          })
        : suspensionMessage({
            memberName: v.row.memberName,
            counted: c.counted,
            priorSuspensions: s.prior,
            hostWaiver,
            suspendedOn: s.suspendedOn,
          });
  } catch {
    // A stored event without a usable date: no message, never a 500.
    return html`<p class="muted">
      The message could not be written from the stored report.
    </p>`;
  }
  // RCDATA: escaped text, never an attribute or a script.
  const box = html`<textarea class="copy" readonly rows="8">${text}</textarea>`;
  if (v.row.classification === 'warning' && actions.has('copy_warning')) {
    return form(
      'copy_warning',
      html`${box}
        <button type="submit" data-copy-near data-then-submit>
          Copy warning
        </button>`,
      true,
    );
  }
  const label =
    v.row.classification === 'warning'
      ? 'Copy warning'
      : 'Copy suspension message';
  return html`<div data-copy-box>
    ${box}<button type="button" data-copy-near>${label}</button>
  </div>`;
}

function historyBody(events: WorkspaceEvent[]): SafeHtml {
  if (events.length === 0) {
    return html`<p class="muted">Nothing yet.</p>`;
  }
  const newestFirst = [...events]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 10);
  return html`<ul>
    ${newestFirst.map(
      (e) =>
        html`<li>
          ${pacificDateTime(e.createdAt)} ·
          ${
            e.actor === 'sync'
              ? 'automatic update'
              : discordUserLink(e.actor, 'staff member')
          }
          · ${actionTitle(e.action)} · ${statusLabel(e.oldStatus)} →
          ${statusLabel(e.newStatus)}${
            e.note ? html` · ${memberText(e.note)}` : ''
          }
        </li>`,
    )}
  </ul>`;
}

/** Actions that park or reopen a card: secondary (ghost) buttons. */
const SECONDARY_ACTIONS: ReadonlySet<WorkspaceAction> =
  new Set<WorkspaceAction>(['hold', 'skip', 'reopen']);

/** One member card: a pure function of what the page read for this row. */
function cardHtml(v: CardView): SafeHtml {
  const { row } = v;
  const actions = new Set(
    allowedActions(row).filter(
      // Recording, linking and voiding: Leadership only. The POST checks
      // again, live; this only decides what is shown. A banned member's
      // card offers no record or link; the repository refuses them too.
      // Nor does any card while the ban status is unknown.
      (a) =>
        (v.leader || !LEADERSHIP_ONLY_ACTIONS.includes(a)) &&
        !((v.banned || !v.banStatusKnown) && BAN_BLOCKED_ACTIONS.includes(a)),
    ),
  );
  const rowUrl = localUrl(workspaceRowPath(row.period, row.id));
  const hidden = html`<input type="hidden" name="_csrf" value="${v.csrf}" />
    <input type="hidden" name="version" value="${row.version}" />`;
  function form(
    action: WorkspaceAction,
    inner: SafeHtml,
    box = false,
  ): SafeHtml {
    const fields = html`${hidden}
      <input type="hidden" name="action" value="${action}" />${inner}`;
    return box
      ? html`<form method="post" action="${rowUrl}" data-copy-box>
          ${fields}
        </form>`
      : html`<form method="post" action="${rowUrl}">${fields}</form>`;
  }
  function button(
    action: WorkspaceAction,
    label: string,
    extra: SafeHtml | '' = '',
  ): SafeHtml | '' {
    if (!actions.has(action)) {
      return '';
    }
    // Voiding undoes a suspension: the destructive (coral ghost) button.
    // Parking or reopening a card is secondary: ghost. Marking it sent is
    // the card's main action: primary.
    if (action === 'void') {
      return form(
        action,
        html`${extra}<button type="submit" class="danger">${label}</button>`,
      );
    }
    return SECONDARY_ACTIONS.has(action)
      ? form(
          action,
          html`${extra}<button type="submit" class="ghost">${label}</button>`,
        )
      : form(action, html`${extra}<button type="submit">${label}</button>`);
  }
  const noteBox = (label: string, max: number) =>
    html`<label class="field"
      >${label}
      <textarea name="note" rows="2" maxlength="${max}" required></textarea>
    </label>`;
  // One line: the textarea's text is exactly the stored notes. The parser
  // drops one newline right after the start tag, so the template writes its
  // own and notes that begin with a newline keep it.
  // prettier-ignore
  const notesArea = html`<textarea name="note" rows="3" maxlength="${NOTES_MAX}">\n${row.notes}</textarea>`;
  const unlinked = v.records.filter(
    (r) => inLinkWindow(r, row.period) && r.id !== row.suspensionRecordId,
  );
  const outside = unlinked.filter((r) => !v.linkedElsewhere.has(r.id));
  const elsewhereBody = unlinked
    .filter((r) => v.linkedElsewhere.has(r.id))
    .map(
      (r) =>
        html`<p class="muted">Recorded on another month's card (#${r.id})</p>`,
    );
  const outsideBody = outside.map(
    (r) =>
      html`<p class="note info">
          Suspended outside the workspace on ${recordDay(r.suspendedAt)}
          (#${r.id})
        </p>
        ${
          actions.has('link_suspension')
            ? form(
                'link_suspension',
                html`<input type="hidden" name="recordId" value="${r.id}" />
                  <button type="submit">Link suspension #${r.id}</button>`,
              )
            : ''
        }`,
  );
  const profile = meetupProfileUrl(row.memberId);
  return html`<div class="card ws-card">
    <h2>
      ${memberLink({ id: row.memberId, name: row.memberName })}
      ${
        row.classification === 'suspension'
          ? html`<span class="badge info">Suspension candidate</span>`
          : html`<span class="badge attn">Warning</span>`
      }
      ${statusBadge(row.status)}
      ${v.banned ? html`<span class="badge attn">Banned</span>` : ''}
    </h2>
    ${
      row.inLatestSnapshot
        ? ''
        : html`<p class="note attn">
            No longer in the latest report for this month.
          </p>`
    }
    ${caseBody(v)} ${upcomingBody(v.upcoming, v.now)} ${suspensionBody(v)}
    ${outsideBody} ${elsewhereBody} ${messageBody(v, form, actions)}
    ${
      profile
        ? html`<p>
            <a href="${profile}" rel="noopener noreferrer" target="_blank"
              >Open on Meetup</a
            >
            <span class="muted"
              >(send the message there while signed in as the organizer
              account)</span
            >
          </p>`
        : ''
    }
    <div class="actions">
      ${button('mark_sent', 'Mark as sent')}
      ${button('hold', 'Put on hold', noteBox('Why', NOTES_MAX))}
      ${button('skip', 'Skip', noteBox('Why', NOTES_MAX))}
      ${button('reopen', 'Reopen')}
      ${
        actions.has('record_suspension')
          ? html`<a
              class="button"
              href="${localUrl(workspaceRowPath(row.period, row.id, 'suspend'))}"
              >Record suspension…</a
            >`
          : ''
      }
      ${button('void', 'Void suspension', noteBox('Reason', VOID_REASON_MAX))}
    </div>
    ${form(
      'edit_notes',
      html`<label class="field">Notes ${notesArea} </label>
        <button type="submit" class="ghost">Save notes</button>`,
    )}
    <details>
      <summary>History</summary>
      ${historyBody(v.events)}
    </details>
  </div>`;
}

const sum = (
  counts: Partial<Record<WorkspaceStatus, number>> | undefined,
  statuses: readonly WorkspaceStatus[],
) => statuses.reduce((n, s) => n + (Number(counts?.[s]) || 0), 0);

/** The months as links, the current one plain text. */
function monthPicker(period: Period, now: Date): SafeHtml {
  return html`<nav class="pager choices" aria-label="Months">
    ${workspaceMonths(now).map((p) => {
      if (comparePeriods(p, period) === 0) {
        return html`<strong>${monthLabel(p)}</strong>`;
      }
      return monthCell(DASHBOARD_PATHS.workspaceMonth, p);
    })}
  </nav>`;
}

function syncForm(period: Period, csrf: string, label: string): SafeHtml {
  return html`<form
    method="post"
    action="${localUrl(monthPath(DASHBOARD_PATHS.workspaceSync, period))}"
  >
    <input type="hidden" name="_csrf" value="${csrf}" />
    <button type="submit">${label}</button>
  </form>`;
}

function leadershipNote(answer: LeadershipAnswer): SafeHtml | '' {
  return answer === 'unreachable'
    ? html`<p class="note attn">${UNREACHABLE_NOTE}</p>`
    : '';
}

/** How long the month page may reuse a user's Leadership answer, for display only. */
export const LEADERSHIP_DISPLAY_CACHE_MS = 60_000;
/** At most this many users are remembered; the oldest entry goes first. */
export const LEADERSHIP_DISPLAY_CACHE_MAX = 200;

/**
 * Per-user, in-process memory of the live Leadership check, used only to
 * show or hide the month page's record, link and void controls. Only
 * 'leader' and 'not-leader' are kept, never 'unreachable'. Never the
 * authority: the confirm page and every POST ask Discord live.
 */
export class LeadershipDisplayCache {
  private readonly entries = new Map<
    string,
    { answer: 'leader' | 'not-leader'; at: number }
  >();

  constructor(private readonly now: () => number) {}

  get size(): number {
    return this.entries.size;
  }

  async get(
    userId: string,
    ask: () => Promise<LeadershipAnswer>,
  ): Promise<LeadershipAnswer> {
    const hit = this.entries.get(userId);
    if (hit && this.now() - hit.at < LEADERSHIP_DISPLAY_CACHE_MS) {
      return hit.answer;
    }
    this.entries.delete(userId);
    const answer = await ask();
    if (answer !== 'unreachable') {
      this.entries.set(userId, { answer, at: this.now() });
      // A Map keeps insertion order, and a refreshed entry was deleted
      // first: the first keys are the oldest.
      const excess = this.entries.size - LEADERSHIP_DISPLAY_CACHE_MAX;
      if (excess > 0) {
        [...this.entries.keys()]
          .slice(0, excess)
          .forEach((key) => this.entries.delete(key));
      }
    }
    return answer;
  }
}

function refusedConfirm(res: Response, answer: LeadershipAnswer): void {
  const unreachable = answer === 'unreachable';
  dashboardPage(res, {
    title: 'Record suspension',
    status: unreachable ? 503 : 403,
    body: html`<div class="card">
      <h1>Record suspension</h1>
      <p>
        ${
          unreachable
            ? 'Discord could not be reached to check your role. Try again in a minute.'
            : 'Only the 1.5 Leadership Team can record suspensions.'
        }
      </p>
    </div>`,
  });
}

/**
 * GET /dashboard/no-shows (the months), /dashboard/no-shows/:period (the
 * month's member cards) and /dashboard/no-shows/:period/rows/:rowId/suspend
 * (the record-suspension confirm step). Reads only: the one write any of
 * them can cause is the upcoming-RSVP loader's Redis cache. Every read runs
 * under the page deadline; the Leadership check under its own.
 */
export function registerWorkspaceRoutes(
  router: express.Router,
  deps: Pick<
    DashboardPageDeps,
    | 'now'
    | 'workspace'
    | 'snapshots'
    | 'suspensions'
    | 'upcoming'
    | 'isLeadership'
    | 'bans'
  >,
): void {
  const displayLeadership = new LeadershipDisplayCache(() =>
    deps.now().getTime(),
  );
  router.get(DASHBOARD_PATHS.workspace, (async (_req, res) => {
    const now = deps.now();
    const months = workspaceMonths(now).slice(0, LIST_MONTHS);
    const loaded = await load(res, WHAT, async () => {
      const ws = await deps.workspace();
      return Promise.all([ws.listMonths(), ws.statusCounts(months)]);
    });
    if (!loaded.ok) {
      return;
    }
    const [states, counts] = loaded.value;
    const stateOf = (p: Period) =>
      states.find((s) => comparePeriods(s.period, p) === 0);
    dashboardPage(res, {
      title: 'No-show workspace',
      body: html`<div class="card">
        <h1>No-show workspace</h1>
        <p class="muted">
          One card per member with no-shows, from September 2026 on. Older
          months are on the no-show history pages.
        </p>
        <table class="stack">
          <thead>
            <tr>
              <th>Month</th>
              <th>To do</th>
              <th>On hold</th>
              <th>Done</th>
              <th>Set up</th>
            </tr>
          </thead>
          <tbody>
            ${months.map((p) => {
              const c = counts.get(periodKey(p));
              const state = stateOf(p);
              return html`<tr>
                <td data-label="Month">
                  ${monthCell(DASHBOARD_PATHS.workspaceMonth, p)}
                </td>
                <td data-label="To do">${sum(c, OPEN_STATUSES)}</td>
                <td data-label="On hold">${sum(c, PARKED_STATUSES)}</td>
                <td data-label="Done">${sum(c, DONE_STATUSES)}</td>
                <td data-label="Set up">
                  ${
                    state
                      ? `Updated ${pacificDateTime(state.syncedAt)}`
                      : 'Not set up yet'
                  }
                </td>
              </tr>`;
            })}
          </tbody>
        </table>
      </div>`,
    });
  }) as RequestHandler);

  router.get(DASHBOARD_PATHS.workspaceMonth, (async (req, res) => {
    const now = deps.now();
    const period = parseWorkspaceMonth(req.params.period, now);
    if (period === undefined) {
      notFound(res);
      return;
    }
    const page = parsePage(req.query.page);
    const offset = (page - 1) * PAGE_SIZE;
    const { session } = dashboardLocals(res);
    // In parallel with the reads; it only decides what the cards show, so
    // a cached answer (up to 60 s) is enough here. The confirm page and
    // every POST ask Discord live.
    const leadership = displayLeadership.get(session.userId, () =>
      leadershipOf(deps.isLeadership, session.userId),
    );
    const loaded = await load(res, WHAT, async () => {
      const [ws, snapshots, susp] = await Promise.all([
        deps.workspace(),
        deps.snapshots(),
        deps.suspensions(),
      ]);
      const [state, rows, counts, snapshot] = await Promise.all([
        ws.monthState(period),
        ws.listRows(period, { offset, limit: PAGE_SIZE }),
        ws.countRows(period),
        snapshots.getCurrent('no_show', period),
      ]);
      const rowIds = rows.map((r) => r.id);
      const memberIds = [...new Set(rows.map((r) => r.memberId))];
      const linkedIds = rows
        .map((r) => r.suspensionRecordId)
        .filter((id): id is number => id !== null);
      // The ban status is read alongside, not in here: a failing bans
      // read hides record and link (see banStatus) instead of the page.
      const banStatus = loadOptional('ban status', async () =>
        (await deps.bans()).activeMemberIds(memberIds),
      );
      const [events, records, linked] = await Promise.all([
        ws.listRecentEvents(rowIds, 10),
        susp.listByMemberIds(memberIds),
        susp.listByIds(linkedIds),
      ]);
      // Records a card would offer to link: is any already on some row?
      const candidates = [
        ...new Set(
          records
            .filter((r) => inLinkWindow(r, period) && !linkedIds.includes(r.id))
            .map((r) => r.id),
        ),
      ];
      const linkedElsewhere =
        candidates.length > 0
          ? await ws.linkedRecordIds(candidates)
          : new Set<number>();
      return {
        state,
        rows,
        counts,
        snapshot,
        events,
        records,
        linked,
        linkedElsewhere,
        banStatus,
      };
    });
    if (!loaded.ok) {
      // Still observed: leadershipOf never rejects.
      await leadership;
      return;
    }
    const {
      state,
      rows,
      counts,
      snapshot,
      events,
      records,
      linked,
      linkedElsewhere,
      banStatus,
    } = loaded.value;
    // loadOptional never rejects and has its own deadline.
    const bans = await banStatus;
    const banStatusKnown = bans.ok;
    const bannedIds = bans.ok ? bans.value : new Set<string>();
    const answer = await leadership;
    const leader = answer === 'leader';
    const asked = rows
      .filter(
        (r) =>
          r.classification === 'suspension' &&
          r.inLatestSnapshot &&
          // A banned member is never suspended from here: no RSVPs to show.
          !bannedIds.has(r.memberId) &&
          allowedActions(r).some(
            (a) => a === 'record_suspension' || a === 'link_suspension',
          ),
      )
      .map((r) => r.memberId);
    let upcoming = new Map<string, UpcomingEntry>();
    // Unknown ban status: no card offers record or link, so no RSVPs.
    if (banStatusKnown && asked.length > 0) {
      const live = await loadOptional('The upcoming RSVPs', () =>
        deps.upcoming(asked),
      );
      upcoming = live.ok
        ? live.value
        : new Map(asked.map((id) => [id, { state: 'unavailable' }]));
    }
    const payload =
      snapshot && isNoShowPayload(snapshot.payload)
        ? snapshot.payload
        : undefined;
    const caseById = new Map<string, NoShowCasePayload>();
    payload?.cases.forEach((c) => {
      if (typeof c.member.id === 'string') {
        caseById.set(c.member.id, c);
      }
    });
    const label = monthLabel(period);
    const csrf = session.csrfToken;
    let setUp: SafeHtml;
    if (!state) {
      setUp = html`<p>This month's workspace has not been set up yet.</p>
        ${syncForm(period, csrf, 'Set up from the stored report')}`;
    } else if (
      snapshot &&
      (snapshot.id !== state.snapshotId ||
        snapshot.builtAt.getTime() !== state.snapshotBuiltAt.getTime())
    ) {
      setUp = html`<p class="note attn">
          A newer report was built after this workspace was set up.
        </p>
        ${syncForm(period, csrf, 'Update from the stored report')}`;
    } else {
      setUp = staticHtml``;
    }
    const built = snapshot
      ? html`<p class="muted">
          Report built ${pacificDateTime(snapshot.builtAt)} by
          ${builtByHtml(snapshot.builtBy)}${
            state
              ? `; workspace updated ${pacificDateTime(state.syncedAt)}`
              : ''
          }
        </p>`
      : html`<p class="muted">
          No no-show report is stored for ${label} yet.
        </p>`;
    const unreadable =
      snapshot && !payload
        ? html`<p class="note attn">
            The stored report could not be read, so the cards show no messages.
            The build alerts have the details.
          </p>`
        : '';
    const cards = rows.map((row) =>
      cardHtml({
        row,
        csrf,
        now,
        noShowCase: row.inLatestSnapshot
          ? caseById.get(row.memberId)
          : undefined,
        records: records.filter((r) => r.memberId === row.memberId),
        linked: linked.find((r) => r.id === row.suspensionRecordId),
        upcoming: upcoming.get(row.memberId),
        events: events.get(row.id) ?? [],
        linkedElsewhere,
        leader,
        banned: bannedIds.has(row.memberId),
        banStatusKnown,
      }),
    );
    dashboardPage(res, {
      title: `No-show workspace ${label}`,
      script: 'workspace',
      body: html`<div class="card">
          <h1>No-show workspace — ${label}</h1>
          ${workspaceResultNotice(req.query.result)}
          ${refreshNotice(req.query.refresh)} ${leadershipNote(answer)}
          ${
            banStatusKnown
              ? ''
              : html`<p class="note attn">
                  Ban status unavailable. Recording and linking suspensions are
                  hidden. Reload in a minute.
                </p>`
          }
          ${monthPicker(period, now)} ${built} ${unreadable} ${setUp}
          ${refreshForm(period, csrf, 'workspace')}
        </div>
        ${
          rows.length === 0 && state
            ? html`<div class="card"><p>No cards on this page.</p></div>`
            : ''
        }
        ${cards}
        ${pageNav(
          monthPath(DASHBOARD_PATHS.workspaceMonth, period),
          page,
          offset + rows.length < counts.total,
        )}`,
    });
  }) as RequestHandler);

  router.get(DASHBOARD_PATHS.workspaceSuspend, (async (req, res) => {
    const now = deps.now();
    const period = parseWorkspaceMonth(req.params.period, now);
    const rowId = parseRowId(req.params.rowId);
    if (period === undefined || rowId === undefined) {
      notFound(res);
      return;
    }
    const { session } = dashboardLocals(res);
    // Before any read: a Moderator who types the URL never sees the form.
    const answer = await leadershipOf(deps.isLeadership, session.userId);
    if (answer !== 'leader') {
      refusedConfirm(res, answer);
      return;
    }
    const loaded = await load(res, WHAT, async () => {
      const row = await (await deps.workspace()).getRow(period, rowId);
      const [records, bannedIds] = row
        ? await Promise.all([
            (await deps.suspensions()).listByMemberIds([row.memberId]),
            (await deps.bans()).activeMemberIds([row.memberId]),
          ])
        : [[], new Set<string>()];
      return {
        row,
        records,
        banned: row ? bannedIds.has(row.memberId) : false,
      };
    });
    if (!loaded.ok) {
      return;
    }
    const { row, records, banned } = loaded.value;
    if (!row) {
      notFound(res);
      return;
    }
    const back = localUrl(monthPath(DASHBOARD_PATHS.workspaceMonth, period));
    if (banned) {
      // The POST refuses too (applyAction, after the member lock).
      dashboardPage(res, {
        title: 'Record suspension',
        body: html`<div class="card">
          <h1>
            Record suspension —
            ${memberLink({ id: row.memberId, name: row.memberName })}
          </h1>
          <p class="note attn">${WORKSPACE_RESULT_MESSAGES.banned}</p>
          <p><a href="${back}">Back to the workspace</a></p>
        </div>`,
      });
      return;
    }
    if (!allowedActions(row).includes('record_suspension')) {
      dashboardPage(res, {
        title: 'Record suspension',
        body: html`<div class="card">
          <h1>
            Record suspension —
            ${memberLink({ id: row.memberId, name: row.memberName })}
          </h1>
          <p class="note attn">
            This card cannot be suspended from here
            (${statusLabel(row.status)}).
          </p>
          <p><a href="${back}">Back to the workspace</a></p>
        </div>`,
      });
      return;
    }
    const today = pacificToday(now);
    const { min, through } = earliestDay(records, period);
    const latest = latestRecord(records);
    // Only this page's own code; the date is the record's, never the request's.
    const outOfOrder =
      req.query.result !== 'out-of-order'
        ? ''
        : latest
          ? html`<p class="note attn">
              This member already has a suspension dated
              ${recordDay(latest.suspendedAt)}. A new one can't be dated before
              it. Nothing was recorded.
            </p>`
          : workspaceResultNotice('out-of-order');
    const onFile = through
      ? `This member has a suspension on file through ${recordDay(utcMidnight(through))}. ` +
        "A new one can't overlap it or be dated before it, so "
      : '';
    if (min > today) {
      dashboardPage(res, {
        title: 'Record suspension',
        body: html`<div class="card">
          <h1>
            Record suspension —
            ${memberLink({ id: row.memberId, name: row.memberName })}
          </h1>
          ${outOfOrder}
          <p class="note attn">
            ${onFile}it can't be recorded from here right now.
          </p>
          <p><a href="${back}">Back to the workspace</a></p>
        </div>`,
      });
      return;
    }
    const day = chosenDay(req.query.date, period, now, min);
    const prior = priorBefore(records, utcMidnight(day));
    const days = recommendedSuspensionDays(prior);
    const confirmUrl = localUrl(workspaceRowPath(period, row.id, 'suspend'));
    dashboardPage(res, {
      title: 'Record suspension',
      body: html`<div class="card">
        <h1>
          Record suspension —
          ${memberLink({ id: row.memberId, name: row.memberName })}
        </h1>
        ${outOfOrder}
        ${
          through
            ? html`<p>
                ${onFile}the earliest date is ${recordDay(utcMidnight(min))}.
              </p>`
            : ''
        }
        <p>
          Length: 30 days × 2 per earlier suspension, counted from the
          suspensions dated before the chosen day.
          ${day === today ? 'Dated today' : 'Dated the chosen day'} that is
          <strong>${days} days</strong>
          (${plural(prior, 'earlier suspension', 'earlier suspensions')}), plus
          a $${feeDollars(prior)} admin fee to rejoin (none for a member who has
          hosted).
        </p>
        <form method="get" action="${confirmUrl}">
          <label
            >Suspension date
            <input
              type="date"
              name="date"
              value="${day}"
              min="${min}"
              max="${today}"
              required
          /></label>
          <button type="submit" class="ghost">
            Show the length for this date
          </button>
        </form>
        <p>
          Their upcoming RSVPs will be removed on Meetup by whoever applies the
          suspension.
        </p>
        <p>
          Notes for the record:
          ${row.notes ? memberText(row.notes) : html`<span class="muted">none</span>`}
        </p>
        <form
          method="post"
          action="${localUrl(workspaceRowPath(period, row.id))}"
        >
          <input type="hidden" name="_csrf" value="${session.csrfToken}" />
          <input type="hidden" name="version" value="${row.version}" />
          <input type="hidden" name="action" value="record_suspension" />
          <input type="hidden" name="confirm" value="yes" />
          <input type="hidden" name="date" value="${day}" />
          <button type="submit">Record suspension</button>
        </form>
        <p><a href="${back}">Cancel</a></p>
      </div>`,
    });
  }) as RequestHandler);
}

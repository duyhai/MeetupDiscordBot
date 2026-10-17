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
import { workspaceMonths } from '../../lib/workspace/months.js';
import { ACTION_TITLES, STATUS_LABELS } from '../../lib/workspace/service.js';
import {
  feeDollars,
  suspensionMessage,
  warningMessage,
} from '../../lib/workspace/templates.js';
import {
  LEADERSHIP_ONLY_ACTIONS,
  allowedActions,
} from '../../lib/workspace/transitions.js';
import {
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

/** UTC midnight of a YYYY-MM-DD: how suspension dates are stored. */
const utcMidnight = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** A stored suspension date (UTC midnight) as 'Sep 20, 2026', never shifted a day by the timezone. */
const recordDay = (value: Date): string =>
  dayjs.utc(value).format('MMM D, YYYY');

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** Live records dated before today: what the next suspension's length counts (countSuspensionsBefore). */
function priorCount(records: SuspensionRecord[], now: Date): number {
  const today = utcMidnight(pacificToday(now));
  return records.filter((r) => r.suspendedAt < today).length;
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
}

function caseBody(v: CardView): SafeHtml | '' {
  const c = v.noShowCase;
  if (!c) {
    return '';
  }
  const prior = priorCount(v.records, v.now);
  const days = recommendedSuspensionDays(prior);
  const fee =
    c.hostedPastEvent === true
      ? 'has hosted, so no admin fee'
      : `plus a $${feeDollars(prior)} admin fee to rejoin`;
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
      Earlier suspensions: ${prior} · Next suspension: ${days} days (${fee})
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

function messageBody(
  v: CardView,
  form: (action: WorkspaceAction, inner: SafeHtml, box?: boolean) => SafeHtml,
  actions: Set<WorkspaceAction>,
): SafeHtml | '' {
  const c = v.noShowCase;
  if (!c || !v.row.inLatestSnapshot) {
    return '';
  }
  const prior = priorCount(v.records, v.now);
  const hostWaiver = c.hostedPastEvent === true;
  let text: string;
  try {
    text =
      v.row.classification === 'warning'
        ? warningMessage({
            memberName: v.row.memberName,
            event: c.counted[0],
            priorSuspensions: prior,
            hostWaiver,
          })
        : suspensionMessage({
            memberName: v.row.memberName,
            counted: c.counted,
            priorSuspensions: prior,
            hostWaiver,
            suspendedOn: pacificToday(v.now),
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

/** One member card: a pure function of what the page read for this row. */
function cardHtml(v: CardView): SafeHtml {
  const { row } = v;
  const actions = new Set(
    allowedActions(row).filter(
      // Recording, linking and voiding: Leadership only. The POST checks
      // again, live; this only decides what is shown.
      (a) => v.leader || !LEADERSHIP_ONLY_ACTIONS.includes(a),
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
    return actions.has(action)
      ? form(action, html`${extra}<button type="submit">${label}</button>`)
      : '';
  }
  const noteBox = (label: string, max: number) =>
    html`<label
      >${label}
      <textarea name="note" rows="2" maxlength="${max}" required></textarea>
    </label>`;
  // One line: the textarea's text is exactly the stored notes. The parser
  // drops one newline right after the start tag, so the template writes its
  // own and notes that begin with a newline keep it.
  // prettier-ignore
  const notesArea = html`<textarea name="note" rows="3" maxlength="${NOTES_MAX}">\n${row.notes}</textarea>`;
  const floor = utcMidnight(periodDate(row.period));
  const unlinked = v.records.filter(
    (r) => r.suspendedAt >= floor && r.id !== row.suspensionRecordId,
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
      html`<p class="note">
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
      <span class="badge"
        >${
          row.classification === 'suspension'
            ? 'Suspension candidate'
            : 'Warning'
        }</span
      >
      <span class="badge">${statusLabel(row.status)}</span>
    </h2>
    ${
      row.inLatestSnapshot
        ? ''
        : html`<p class="note">
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
      html`<label>Notes ${notesArea} </label>
        <button type="submit">Save notes</button>`,
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
  return html`<nav class="pager">
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
    ? html`<p class="note">${UNREACHABLE_NOTE}</p>`
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
        <table>
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
                <td>${monthCell(DASHBOARD_PATHS.workspaceMonth, p)}</td>
                <td>${sum(c, OPEN_STATUSES)}</td>
                <td>${sum(c, PARKED_STATUSES)}</td>
                <td>${sum(c, DONE_STATUSES)}</td>
                <td>
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
      const [events, records, linked] = await Promise.all([
        ws.listRecentEvents(rowIds, 10),
        susp.listByMemberIds(memberIds),
        susp.listByIds(linkedIds),
      ]);
      // Records a card would offer to link: is any already on some row?
      const floor = utcMidnight(periodDate(period));
      const candidates = [
        ...new Set(
          records
            .filter((r) => r.suspendedAt >= floor && !linkedIds.includes(r.id))
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
    } = loaded.value;
    const answer = await leadership;
    const leader = answer === 'leader';
    const asked = rows
      .filter(
        (r) =>
          r.classification === 'suspension' &&
          r.inLatestSnapshot &&
          allowedActions(r).some(
            (a) => a === 'record_suspension' || a === 'link_suspension',
          ),
      )
      .map((r) => r.memberId);
    let upcoming = new Map<string, UpcomingEntry>();
    if (asked.length > 0) {
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
      setUp = html`<p class="note">
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
        ? html`<p class="note">
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
      }),
    );
    dashboardPage(res, {
      title: `No-show workspace ${label}`,
      script: 'workspace',
      body: html`<div class="card">
          <h1>No-show workspace — ${label}</h1>
          ${workspaceResultNotice(req.query.result)}
          ${refreshNotice(req.query.refresh)} ${leadershipNote(answer)}
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
      const records = row
        ? await (await deps.suspensions()).listByMemberIds([row.memberId])
        : [];
      return { row, records };
    });
    if (!loaded.ok) {
      return;
    }
    const { row, records } = loaded.value;
    if (!row) {
      notFound(res);
      return;
    }
    const back = localUrl(monthPath(DASHBOARD_PATHS.workspaceMonth, period));
    if (!allowedActions(row).includes('record_suspension')) {
      dashboardPage(res, {
        title: 'Record suspension',
        body: html`<div class="card">
          <h1>
            Record suspension —
            ${memberLink({ id: row.memberId, name: row.memberName })}
          </h1>
          <p>
            This card cannot be suspended from here
            (${statusLabel(row.status)}).
          </p>
          <p><a href="${back}">Back to the workspace</a></p>
        </div>`,
      });
      return;
    }
    const prior = priorCount(records, now);
    const days = recommendedSuspensionDays(prior);
    const today = pacificToday(now);
    dashboardPage(res, {
      title: 'Record suspension',
      body: html`<div class="card">
        <h1>
          Record suspension —
          ${memberLink({ id: row.memberId, name: row.memberName })}
        </h1>
        <p>
          Length: 30 days × 2 per earlier suspension. Dated today that is
          <strong>${days} days</strong>
          (${plural(prior, 'earlier suspension', 'earlier suspensions')}).
        </p>
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
          <label
            >Suspension date
            <input
              type="date"
              name="date"
              value="${today}"
              min="${periodDate(period)}"
              max="${today}"
              required
          /></label>
          <button type="submit">Record suspension</button>
        </form>
        <p><a href="${back}">Cancel</a></p>
      </div>`,
    });
  }) as RequestHandler);
}

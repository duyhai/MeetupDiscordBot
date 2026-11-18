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
import {
  SafeHtml,
  SafeUrl,
  html,
  localUrl,
  memberText,
  staticHtml,
} from '../html.js';
import {
  eventLink,
  meetupProfileUrl,
  memberHistoryLink,
  memberLink,
} from '../links.js';
import { loadStaffNames, staffLink } from '../staffNames.js';
import { collapsible } from '../ui/collapsible.js';
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
import { copyBox, copyButton, copyText } from '../ui/copy.js';
import { linkButton } from '../ui/linkButton.js';
import { confirmModal, modal } from '../ui/modal.js';
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

/** Why the earliest date is what it is, when a live record sets it: the start of a sentence. */
function onFileText(through: string | undefined): string {
  return through
    ? `This member has a suspension on file through ${recordDay(utcMidnight(through))}. ` +
        "A new one can't overlap it or be dated before it, so "
    : '';
}

/**
 * The length and fee of a suspension dated `day`, from the live records
 * before it: the record step's own maths (recommendedSuspensionDays,
 * feeDollars). One wording for the confirm page and the Suspend member
 * pop-up.
 */
function lengthLine(day: string, today: string, prior: number): SafeHtml {
  return html`<p>
    Length: 30 days × 2 per earlier suspension, counted from the suspensions
    dated before the chosen day.
    ${day === today ? 'Dated today' : 'Dated the chosen day'} that is
    <strong>${recommendedSuspensionDays(prior)} days</strong>
    (${plural(prior, 'earlier suspension', 'earlier suspensions')}), plus a
    $${feeDollars(prior)} admin fee to rejoin (none for a member who has
    hosted).
  </p>`;
}

const RSVP_LINE = html`<p>
  Their upcoming RSVPs will be removed on Meetup by whoever applies the
  suspension.
</p>`;

const notesForRecord = (notes: string): SafeHtml =>
  html`<p>
    Notes for the record:
    ${notes ? memberText(notes) : html`<span class="muted">none</span>`}
  </p>`;

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
  /** Staff display names (loadStaffNames); a missing one is "staff member". */
  staffNames: Readonly<Record<string, string>>;
  /** The card the last action was on (`?row=`): its heading carries the fixed id the redirect's #acted lands on. */
  acted: boolean;
  /** On the acted card: the result notice again, where the reader now is. */
  notice: SafeHtml | '';
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
      ${staffLink(r.voidedBy, v.staffNames)}: ${memberText(r.voidReason ?? '')}
    </p>`;
}

/**
 * In a message pop-up: Open on Meetup as a button (a link styled by the
 * kit, new tab), then where to send from.
 */
function meetupButton(profile: SafeUrl | undefined): SafeHtml | '' {
  return profile
    ? html`<p>
          ${linkButton({
            href: profile,
            label: 'Open on Meetup',
            external: true,
          })}
        </p>
        <p class="muted">
          (send the message there while signed in as the organizer account)
        </p>`
    : '';
}

/**
 * The message pop-up's button. A warning still to do says Send warning
 * (primary); once sent, skipped or on hold it is only the text to look
 * at again, so it says Warning message (ghost), as a suspended card's
 * Suspension message does. A teammate looking for Mark as sent on a sent
 * card read the primary Send warning as work left (2026-11-17).
 */
function warningTrigger(
  warning: boolean,
  status: WorkspaceStatus,
): { label: string; tone: 'primary' | 'ghost' } {
  if (!warning) {
    return { label: 'Suspend member', tone: 'primary' };
  }
  return OPEN_STATUSES.includes(status)
    ? { label: 'Send warning', tone: 'primary' }
    : { label: 'Warning message', tone: 'ghost' };
}

/** Where the message goes: the member's Meetup profile, opened by the organizer account. */
function meetupLine(profile: SafeUrl | undefined): SafeHtml | '' {
  return profile
    ? html`<p>
        <a href="${profile}" rel="noopener noreferrer" target="_blank"
          >Open on Meetup</a
        >
        <span class="muted"
          >(send the message there while signed in as the organizer
          account)</span
        >
      </p>`
    : '';
}

/**
 * What a card's message part renders: a modal (its trigger sits with the
 * card's actions), or a line of text in the card, or nothing.
 */
interface MessagePart {
  modal: SafeHtml | '';
  inline: SafeHtml | '';
  /** The modal holds the record form, so the card shows no Record suspension link. */
  carriesRecord?: boolean;
}

const NO_MESSAGE: MessagePart = { modal: '', inline: '' };

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
function suspendedMessage(
  v: CardView,
  profile: SafeUrl | undefined,
): MessagePart {
  const s = cardSuspension(v);
  const none: MessagePart = {
    modal: '',
    inline: html`<p class="muted">Suspended — see the record above.</p>`,
  };
  if (!s.recorded) {
    return none;
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
    return none;
  }
  const unchecked = c
    ? ''
    : html`<p class="note attn">
        This member is not in the latest report, so hosting could not be
        checked. If they have hosted, remove the admin fee sentence.
      </p>`;
  return {
    modal: modal({
      trigger: { label: 'Suspension message', tone: 'ghost' },
      title: `Suspension message for ${v.row.memberName || 'this member'}`,
      body: html`${unchecked}${copyBox(text, 'Copy message')}
      ${meetupButton(profile)}`,
    }),
    inline: '',
  };
}

/**
 * The Suspend member pop-up's last part, for Leadership on a card that can
 * be recorded: today's length and fee (the confirm page's wording and
 * maths, from the same live records), the record form posting what the
 * confirm page posts, dated today, and a link to the confirm page for
 * another date. When a live record runs past today, it says so instead.
 */
function recordSection(
  v: CardView,
  fields: (action: WorkspaceAction) => SafeHtml,
  rowUrl: SafeUrl,
): SafeHtml {
  const { row } = v;
  const today = pacificToday(v.now);
  const { min, through } = earliestDay(v.records, row.period);
  if (min > today) {
    return html`<section class="ui-record">
      <h3>Record suspension</h3>
      <p class="note attn">
        ${onFileText(through)}it can't be recorded from here right now.
      </p>
    </section>`;
  }
  const prior = priorBefore(v.records, utcMidnight(today));
  return html`<section class="ui-record">
    <h3>Record suspension</h3>
    ${
      through
        ? html`<p>
            ${onFileText(through)}the earliest date is
            ${recordDay(utcMidnight(min))}.
          </p>`
        : ''
    }
    ${lengthLine(today, today, prior)} ${RSVP_LINE} ${notesForRecord(row.notes)}
    <form method="post" action="${rowUrl}">
      ${fields('record_suspension')}
      <input type="hidden" name="confirm" value="yes" />
      <input type="hidden" name="date" value="${today}" />
      <input type="hidden" name="from" value="popup" />
      <button type="submit">Record suspension</button>
    </form>
    <p class="muted">The length and fee are checked again when you record.</p>
    <p>
      <a href="${localUrl(workspaceRowPath(row.period, row.id, 'suspend'))}"
        >Use a different date…</a
      >
    </p>
  </section>`;
}

function messagePart(
  v: CardView,
  fields: (action: WorkspaceAction) => SafeHtml,
  rowUrl: SafeUrl,
  actions: Set<WorkspaceAction>,
  profile: SafeUrl | undefined,
): MessagePart {
  if (v.row.status === 'suspended') {
    return suspendedMessage(v, profile);
  }
  if (v.row.status === 'voided') {
    return {
      modal: '',
      inline: html`<p class="muted">Voided — no message to send.</p>`,
    };
  }
  const c = v.noShowCase;
  if (!c || !v.row.inLatestSnapshot) {
    return NO_MESSAGE;
  }
  const s = cardSuspension(v);
  const hostWaiver = c.hostedPastEvent === true;
  const warning = v.row.classification === 'warning';
  let text: string;
  try {
    text = warning
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
    return {
      modal: '',
      inline: html`<p class="muted">
        The message could not be written from the stored report.
      </p>`,
    };
  }
  const name = v.row.memberName || 'this member';
  // Copy warning: copies, then submits copy_warning (status Warning copied).
  const copy =
    warning && actions.has('copy_warning')
      ? html`<form method="post" action="${rowUrl}" data-copy-box>
          ${fields('copy_warning')}${copyText(text)}${copyButton({
            label: 'Copy warning',
            target: 'near',
            thenSubmit: true,
          })}
        </form>`
      : copyBox(text, warning ? 'Copy warning' : 'Copy message');
  // Recording is Leadership only: the section renders only when the card
  // offers the action (cardHtml's filter); the POST checks again, live.
  const carriesRecord = !warning && actions.has('record_suspension');
  return {
    modal: modal({
      trigger: warningTrigger(warning, v.row.status),
      title: warning ? `Warning for ${name}` : `Suspend ${name}`,
      body: html`${copy} ${meetupButton(profile)}
      ${carriesRecord ? recordSection(v, fields, rowUrl) : ''}`,
    }),
    inline: '',
    carriesRecord,
  };
}

function historyBody(
  events: WorkspaceEvent[],
  staffNames: Readonly<Record<string, string>>,
): SafeHtml {
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
              : staffLink(e.actor, staffNames)
          }
          · ${actionTitle(e.action)} · ${statusLabel(e.oldStatus)} →
          ${statusLabel(e.newStatus)}${
            e.note ? html` · ${memberText(e.note)}` : ''
          }
        </li>`,
    )}
  </ul>`;
}

// Hold parks a card that is not decided yet (it stays open work); skip closes
// one that needs nothing (it counts as done). The hint shows on hover only,
// so each tip repeats the difference for touch devices.
const HOLD_HINT =
  'Not decided yet: the card stays open as On hold until someone reopens or skips it.';
const HOLD_TIP =
  "Use this when the card can't be finished yet, for example while you wait " +
  'on the member, a host or Leadership. It stays visible as On hold, not ' +
  'done, until someone reopens it, skips it or (for a suspension, Leadership ' +
  'only) records the suspension. Say why, so the next person knows.';
const SKIP_HINT = 'Decided: no action needed. The card counts as done.';
const SKIP_TIP =
  "Use this when you've decided nothing is needed, for example a host's " +
  'mistake, a valid excuse, or waiting for the third no-show before ' +
  'suspending. Nothing more is sent and the card counts as done. Reopen ' +
  'puts it back as it was before. Say why, so the next person knows.';
const NOTES_TIP =
  'For staff only: shown on this card. Each save is kept in the card ' +
  'history and posted to the moderation log.';

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
  /** An action's fields: the CSRF token, the row version and the action. */
  const fields = (action: WorkspaceAction) =>
    html`<input type="hidden" name="_csrf" value="${v.csrf}" />
      <input type="hidden" name="version" value="${row.version}" />
      <input type="hidden" name="action" value="${action}" />`;
  const form = (action: WorkspaceAction, inner: SafeHtml) =>
    html`<form method="post" action="${rowUrl}">
      ${fields(action)}${inner}
    </form>`;
  const noteBox = (label: string, max: number) =>
    html`<label class="field"
      >${label}
      <textarea name="note" rows="3" maxlength="${max}" required></textarea>
    </label>`;
  /**
   * An action that needs a note (hold, skip, void): a button opening a
   * confirm modal with the note field, so nothing opens inline.
   */
  const noteAction = (
    action: 'hold' | 'skip' | 'void',
    copy: {
      trigger: string;
      /** A hover hint on the trigger button; the tip must cover it too. */
      hint?: string;
      title: string;
      /** The confirm button: never the trigger's own words. */
      confirm: string;
      tip: SafeHtml | string;
      field: string;
      max: number;
    },
  ): SafeHtml | '' => {
    if (!actions.has(action)) {
      return '';
    }
    // Voiding undoes a suspension: the destructive (coral) button. Parking
    // a card is secondary: ghost.
    const danger = action === 'void';
    return confirmModal({
      trigger: {
        label: copy.trigger,
        tone: danger ? 'danger' : 'ghost',
        ...(copy.hint === undefined ? {} : { hint: copy.hint }),
      },
      title: copy.title,
      tip: copy.tip,
      action: rowUrl,
      fields: html`${fields(action)}${noteBox(copy.field, copy.max)}`,
      confirmLabel: copy.confirm,
      tone: danger ? 'danger' : 'primary',
    });
  };
  // One line: the textarea's text is exactly the stored notes. The parser
  // drops one newline right after the start tag, so the template writes its
  // own and notes that begin with a newline keep it.
  // prettier-ignore
  const notesArea = html`<textarea name="note" rows="5" maxlength="${NOTES_MAX}">\n${row.notes}</textarea>`;
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
  const message = messagePart(v, fields, rowUrl, actions, profile);
  const recordId = v.linked?.id ?? row.suspensionRecordId;
  const headingBody = html`${memberLink({
    id: row.memberId,
    name: row.memberName,
  })}
  ${
    row.classification === 'suspension'
      ? html`<span class="badge info">Suspension candidate</span>`
      : html`<span class="badge attn">Warning</span>`
  }
  ${statusBadge(row.status)}
  ${v.banned ? html`<span class="badge attn">Banned</span>` : ''}`;
  // The id is a literal (html.ts never takes one interpolated): only the
  // card the redirect named carries it, so #acted lands there.
  const heading = v.acted
    ? html`<h2 id="acted" class="ws-acted">${headingBody}</h2>`
    : html`<h2>${headingBody}</h2>`;
  const history = memberHistoryLink(row.memberId);
  return html`<div class="card ws-card">
    ${heading}
    ${
      history
        ? html`<p class="ws-links">
            <a href="${history}">No-show history</a>
          </p>`
        : ''
    }
    ${v.acted ? v.notice : ''}
    ${
      row.inLatestSnapshot
        ? ''
        : html`<p class="note attn">
            No longer in the latest report for this month.
          </p>`
    }
    ${caseBody(v)} ${upcomingBody(v.upcoming, v.now)} ${suspensionBody(v)}
    ${outsideBody} ${elsewhereBody} ${message.inline}
    ${message.modal ? '' : meetupLine(profile)}
    ${
      row.notes.trim()
        ? html`<p class="ws-notes">
            <strong>Notes:</strong> ${memberText(row.notes.trim())}
          </p>`
        : ''
    }
    <div class="actions">
      ${message.modal}
      ${
        actions.has('mark_sent')
          ? form('mark_sent', html`<button type="submit">Mark as sent</button>`)
          : ''
      }
      ${noteAction('hold', {
        trigger: 'Put on hold',
        hint: HOLD_HINT,
        title: 'Put this card on hold',
        confirm: 'Put this card on hold',
        tip: HOLD_TIP,
        field: 'Why',
        max: NOTES_MAX,
      })}
      ${noteAction('skip', {
        trigger: 'Skip',
        hint: SKIP_HINT,
        title: 'Skip this card',
        confirm: 'Skip this card',
        tip: SKIP_TIP,
        field: 'Why',
        max: NOTES_MAX,
      })}
      ${
        actions.has('reopen')
          ? form(
              'reopen',
              html`<button type="submit" class="ghost">Reopen</button>`,
            )
          : ''
      }
      ${
        actions.has('record_suspension') && !message.carriesRecord
          ? html`<a
              class="button"
              href="${localUrl(workspaceRowPath(row.period, row.id, 'suspend'))}"
              >Record suspension…</a
            >`
          : ''
      }
      ${noteAction('void', {
        trigger: 'Void suspension',
        title: 'Void this suspension?',
        confirm: 'Void this suspension',
        tip: html`Voiding marks
        ${recordId === null ? 'the suspension record' : `suspension #${recordId}`}
        as void: it stops counting toward this member's later suspension lengths
        and admin fees, and leaves the active suspensions list. The card moves
        to Voided, where a suspension can be recorded again. Nothing changes on
        Meetup: if the member was removed there, re-admit them on Meetup
        yourself. The reason is kept with the record and posted to the
        moderation log.`,
        field: 'Reason',
        max: VOID_REASON_MAX,
      })}
      ${confirmModal({
        trigger: { label: 'Edit notes', tone: 'ghost' },
        title: 'Notes',
        tip: NOTES_TIP,
        action: rowUrl,
        fields: html`${fields('edit_notes')}<label class="field"
            >Notes ${notesArea}</label
          >`,
        confirmLabel: 'Save notes',
        tone: 'primary',
      })}
    </div>
    <details>
      <summary>History</summary>
      ${historyBody(v.events, v.staffNames)}
    </details>
  </div>`;
}

const sum = (
  counts: Partial<Record<WorkspaceStatus, number>> | undefined,
  statuses: readonly WorkspaceStatus[],
) => statuses.reduce((n, s) => n + (Number(counts?.[s]) || 0), 0);

/**
 * The month's To do / On hold / Done, from statusCounts: the same numbers
 * as the months list and Home. Classes are literals; only counts are data.
 */
function statusSummary(
  counts: Partial<Record<WorkspaceStatus, number>> | undefined,
): SafeHtml {
  return html`<dl class="stats ws-summary">
    <div class="stat todo">
      <dt>To do</dt>
      <dd>${sum(counts, OPEN_STATUSES)}</dd>
    </div>
    <div class="stat">
      <dt>On hold</dt>
      <dd>${sum(counts, PARKED_STATUSES)}</dd>
    </div>
    <div class="stat done">
      <dt>Done</dt>
      <dd>${sum(counts, DONE_STATUSES)}</dd>
    </div>
  </dl>`;
}

type CardGroup = 'todo' | 'hold' | 'done';

function groupOf(status: WorkspaceStatus): CardGroup {
  if (OPEN_STATUSES.includes(status)) {
    return 'todo';
  }
  return PARKED_STATUSES.includes(status) ? 'hold' : 'done';
}

const GROUPS: readonly {
  group: CardGroup;
  title: string;
  empty: string;
}[] = [
  { group: 'todo', title: 'To do', empty: 'Nothing to do on this page.' },
  { group: 'hold', title: 'On hold', empty: 'Nothing on hold on this page.' },
  { group: 'done', title: 'Done', empty: 'Nothing done on this page yet.' },
];

/**
 * This page's cards in three folding sections: To do and On hold open, Done
 * closed unless it holds the card just acted on. listRows sorts by the same
 * groups, so undone cards come first across pages too.
 */
function cardSections(
  rows: WorkspaceRow[],
  actedId: number | undefined,
  cardOf: (row: WorkspaceRow) => SafeHtml,
  /** The month spans more than one page: the counts say "on this page". */
  multiPage: boolean,
): SafeHtml {
  return html`${GROUPS.map(({ group, title, empty }) => {
    const inGroup = rows.filter((r) => groupOf(r.status) === group);
    const open = group !== 'done' || inGroup.some((r) => r.id === actedId);
    return collapsible({
      summary: title,
      // The summary above counts the whole month; these count this page.
      meta: multiPage
        ? `${inGroup.length} on this page`
        : plural(inGroup.length, 'card', 'cards'),
      open,
      body: inGroup.length
        ? html`${inGroup.map(cardOf)}`
        : html`<p class="muted">${empty}</p>`,
    });
  })}`;
}

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
    | 'staffNames'
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
      const [state, rows, counts, snapshot, statusCounts] = await Promise.all([
        ws.monthState(period),
        ws.listRows(period, { offset, limit: PAGE_SIZE }),
        ws.countRows(period),
        snapshots.getCurrent('no_show', period),
        // The months list's and Home's counts, so the three numbers agree.
        ws.statusCounts([period]),
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
        statusCounts,
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
      statusCounts,
      events,
      records,
      linked,
      linkedElsewhere,
      banStatus,
    } = loaded.value;
    // Who acted and who voided, named in one lookup; never rejects, and
    // bounded by its own budget (a miss is "staff member").
    const staffNames = loadStaffNames(deps.staffNames, [
      ...[...events.values()].flat().map((e) => e.actor),
      ...linked.map((r) => r.voidedBy),
    ]);
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
    const names = await staffNames;
    const actedId = parseRowId(req.query.row);
    const cardOf = (row: WorkspaceRow) =>
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
        staffNames: names,
        acted: row.id === actedId,
        notice: workspaceResultNotice(req.query.result),
      });
    const monthCounts = statusCounts.get(periodKey(period));
    dashboardPage(res, {
      title: `No-show workspace ${label}`,
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
          ${monthPicker(period, now)} ${state ? statusSummary(monthCounts) : ''}
          ${built} ${unreadable} ${setUp}
          ${refreshForm(period, csrf, 'workspace')}
        </div>
        ${
          rows.length === 0 && state
            ? html`<div class="card"><p>No cards on this page.</p></div>`
            : ''
        }
        ${rows.length > 0 ? cardSections(rows, actedId, cardOf, counts.total > PAGE_SIZE) : ''}
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
    // Only this page's own codes; the date is the record's, never the request's.
    const dayChanged =
      req.query.result === 'day-changed'
        ? workspaceResultNotice('day-changed')
        : '';
    const outOfOrder =
      req.query.result !== 'out-of-order'
        ? dayChanged
        : latest
          ? html`<p class="note attn">
              This member already has a suspension dated
              ${recordDay(latest.suspendedAt)}. A new one can't be dated before
              it. Nothing was recorded.
            </p>`
          : workspaceResultNotice('out-of-order');
    const onFile = onFileText(through);
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
        ${lengthLine(day, today, prior)}
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
        ${RSVP_LINE} ${notesForRecord(row.notes)}
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

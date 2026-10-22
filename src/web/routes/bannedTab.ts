import { BAN_CSV_HEADER } from '../../lib/bans/banCsv.js';
import type { BanResultCode } from '../../lib/bans/service.js';
import {
  BAN_LIFT_REASON_MAX,
  BAN_NAME_MAX,
  BAN_NOTES_MAX,
  BanRow,
  BanState,
} from '../../lib/bans/types.js';
import {
  DASHBOARD_BASE,
  DASHBOARD_PATHS,
  dashboardPath,
} from '../../lib/reports/dashboardPaths.js';
import { SafeHtml, html, localUrl, memberText } from '../html.js';
import { discordUserLink, memberLink } from '../links.js';
import { pacificDate, pacificDateTime } from '../pageKit.js';
import { PAGE_SIZE, pageNav } from '../paging.js';

export const BAN_STATES: readonly BanState[] = ['active', 'lifted'];

const SHOW_LABELS: Record<BanState, string> = {
  active: 'Active',
  lifted: 'Lifted',
};

/** `?show=` when it is one of the two states (a plain string), else active. */
export function parseBanShow(value: unknown): BanState {
  return BAN_STATES.find((s) => s === value) ?? 'active';
}

/** '/dashboard/suspensions?state=banned', plus `show` and `result` when given. */
export function bannedTabPath(
  params: { show?: BanState; result?: string } = {},
): string {
  const query = new URLSearchParams({ state: 'banned' });
  if (params.show !== undefined) {
    query.set('show', params.show);
  }
  if (params.result !== undefined && params.result !== '') {
    query.set('result', params.result);
  }
  return `${dashboardPath(DASHBOARD_PATHS.suspensions)}?${query.toString()}`;
}

const MAX_SERIAL = 2 ** 31 - 1;

/** '/dashboard/bans/12/photo': only for a ban id from 1 to 2^31-1. Throws RangeError. */
export function banPhotoPath(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_SERIAL) {
    throw new RangeError('banPhotoPath needs a ban id from 1 to 2^31-1');
  }
  return `${DASHBOARD_BASE}${DASHBOARD_PATHS.banPhoto.replace(':id', String(id))}`;
}

/** '/dashboard/bans/12/lift': only for a ban id from 1 to 2^31-1. Throws RangeError. */
export function banLiftPath(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_SERIAL) {
    throw new RangeError('banLiftPath needs a ban id from 1 to 2^31-1');
  }
  return `${DASHBOARD_BASE}${DASHBOARD_PATHS.banLift.replace(':id', String(id))}`;
}

/** Fixed text per ban result code. Nothing from the request or the database is ever shown. */
export const BAN_RESULT_MESSAGES = {
  recorded: 'Ban recorded.',
  imported: 'Bans imported.',
  lifted: 'Ban lifted. The record and its photo are kept.',
  'photo-saved': 'Photo saved.',
  invalid:
    'That request could not be understood. Reload the page and try again.',
  'bad-member-id':
    'The member id must be the Meetup member number, 1 to 20 digits. Nothing was recorded.',
  'bad-date':
    'The ban date must be blank or a real date from 2013-03-01 through today.',
  'name-too-long': 'The name is too long (up to 500 characters).',
  'notes-too-long': 'The notes are too long (up to 2000 characters).',
  'already-banned':
    'This member already has an active ban. Nothing was recorded.',
  'not-active': 'That ban is not active (already lifted, or not found).',
  'reason-required': 'Add a reason for lifting the ban, then try again.',
  'reason-too-long': 'That reason is too long (up to 500 characters).',
  'photo-not-accepted':
    'That photo was not accepted. Pick a JPEG or WebP image and try again.',
  'photo-too-large': 'That photo is over 150 KB after compression.',
  'photo-too-big': 'That photo is over 512 pixels on a side.',
  'not-leadership':
    'Only the 1.5 Leadership Team can record, import, upload or lift a ban. Nothing was changed.',
  'leadership-unavailable':
    'Discord could not be reached to check your role. Nothing was changed; try again in a minute.',
  error: 'That did not save. Please try again in a minute.',
} as const satisfies Record<BanResultCode, string>;

const isBanResultCode = (code: unknown): code is BanResultCode =>
  typeof code === 'string' && Object.hasOwn(BAN_RESULT_MESSAGES, code);

/** The codes that report something done: a blurple notice; every other code is coral. */
const BAN_RESULT_INFO: ReadonlySet<BanResultCode> = new Set([
  'recorded',
  'imported',
  'lifted',
  'photo-saved',
]);

/** Fixed text for a known code; anything else in the query renders nothing (never echoed). */
export function banResultNotice(code: unknown): SafeHtml | '' {
  if (!isBanResultCode(code)) {
    return '';
  }
  return BAN_RESULT_INFO.has(code)
    ? html`<p class="note info">${BAN_RESULT_MESSAGES[code]}</p>`
    : html`<p class="note attn">${BAN_RESULT_MESSAGES[code]}</p>`;
}

export interface BannedTabView {
  show: BanState;
  rows: BanRow[];
  counts: Record<BanState, number>;
  page: number;
  notice: SafeHtml | '';
  /**
   * The viewer may change bans: shows the forms. A display check only;
   * every POST asks Discord live.
   */
  leader: boolean;
  csrf: string;
  /** Pacific today ('YYYY-MM-DD'): the date field's max. */
  today: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const isValidDate = (v: unknown): v is Date =>
  v instanceof Date && !Number.isNaN(v.getTime());

const isOptionalDate = (v: unknown): boolean => v === null || isValidDate(v);

const isOptionalText = (v: unknown): boolean =>
  v === null || typeof v === 'string';

/**
 * A row this tab can render; anything else is the 503 page, never a 500.
 * A lifted-tab row must carry a valid lift time.
 */
export function isBanRow(row: unknown, show: BanState): row is BanRow {
  if (typeof row !== 'object' || row === null) {
    return false;
  }
  const r = row as Record<string, unknown>;
  return (
    Number.isSafeInteger(r.id) &&
    (r.id as number) >= 1 &&
    (r.id as number) <= MAX_SERIAL &&
    typeof r.memberId === 'string' &&
    typeof r.memberName === 'string' &&
    (r.bannedOn === null ||
      (typeof r.bannedOn === 'string' && DAY.test(r.bannedOn))) &&
    typeof r.notes === 'string' &&
    typeof r.recordedBy === 'string' &&
    isValidDate(r.createdAt) &&
    typeof r.hasPhoto === 'boolean' &&
    (r.photoSource === null ||
      r.photoSource === 'upload' ||
      r.photoSource === 'profile') &&
    isOptionalDate(r.photoUpdatedAt) &&
    isOptionalText(r.photoUpdatedBy) &&
    (show === 'lifted' ? isValidDate(r.liftedAt) : r.liftedAt === null) &&
    isOptionalText(r.liftedBy) &&
    isOptionalText(r.liftReason)
  );
}

function photoCell(row: BanRow): SafeHtml {
  // Lazy: one photo per request, and a long list should not fetch them all.
  return row.hasPhoto
    ? html`<img
        class="ban-photo"
        src="${localUrl(banPhotoPath(row.id))}"
        width="96"
        height="96"
        alt="Photo of the banned member"
        loading="lazy"
      />`
    : html`<span class="muted">No photo</span>`;
}

function photoSourceCell(row: BanRow): SafeHtml | '' {
  if (!row.hasPhoto || row.photoUpdatedAt === null) {
    return '';
  }
  const on = pacificDate(row.photoUpdatedAt);
  if (row.photoSource === 'upload') {
    return html`Uploaded by
    ${discordUserLink(row.photoUpdatedBy, 'staff member')} on ${on}`;
  }
  if (row.photoSource === 'profile') {
    return html`From their profile on ${on}`;
  }
  return '';
}

function csrfField(csrf: string): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${csrf}" />`;
}

function liftForm(row: BanRow, csrf: string): SafeHtml {
  return html`<form method="post" action="${localUrl(banLiftPath(row.id))}">
    ${csrfField(csrf)}
    <label
      >Reason
      <textarea
        name="reason"
        rows="2"
        maxlength="${BAN_LIFT_REASON_MAX}"
        required
      ></textarea>
    </label>
    <button type="submit" class="danger">Lift ban</button>
  </form>`;
}

function banRowHtml(
  row: BanRow,
  lifted: boolean,
  lift: SafeHtml | undefined,
): SafeHtml {
  return html`<tr>
    <td data-label="Photo">${photoCell(row)}</td>
    <td data-label="Member">
      ${memberLink({ id: row.memberId, name: row.memberName || row.memberId })}
      (${row.memberId})
    </td>
    <td data-label="Banned">${row.bannedOn ?? 'Date unknown'}</td>
    <td data-label="Recorded by">
      ${discordUserLink(row.recordedBy, 'staff member')}
    </td>
    <td data-label="Notes">${row.notes ? memberText(row.notes) : ''}</td>
    <td data-label="Photo from">${photoSourceCell(row)}</td>
    ${
      lifted
        ? html`<td data-label="Lifted">
              ${pacificDateTime(row.liftedAt ?? '')} Pacific
            </td>
            <td data-label="Lifted by">
              ${discordUserLink(row.liftedBy, 'staff member')}
            </td>
            <td data-label="Reason">
              ${row.liftReason ? memberText(row.liftReason) : ''}
            </td>`
        : ''
    }
    ${lift === undefined ? '' : html`<td data-label="Lift">${lift}</td>`}
  </tr>`;
}

function showChoices(
  current: BanState,
  counts: Record<BanState, number>,
): SafeHtml {
  return html`<nav class="pager choices" aria-label="Bans">
    ${BAN_STATES.map((show) => {
      const label = `${SHOW_LABELS[show]} (${Number(counts[show]) || 0})`;
      return show === current
        ? html`<strong>${label}</strong>`
        : html`<a href="${localUrl(bannedTabPath({ show }))}">${label}</a>`;
    })}
  </nav>`;
}

function bansTable(view: BannedTabView): SafeHtml {
  const pager = pageNav(
    dashboardPath(DASHBOARD_PATHS.suspensions),
    view.page,
    view.rows.length === PAGE_SIZE,
    { state: 'banned', show: view.show },
  );
  if (view.rows.length === 0) {
    return view.page > 1
      ? html`<p>No more bans.</p>
          ${pager}`
      : html`<p>No ${SHOW_LABELS[view.show].toLowerCase()} bans.</p>`;
  }
  const lifted = view.show === 'lifted';
  const canLift = view.leader && !lifted;
  return html`<table class="stack">
      <thead>
        <tr>
          <th>Photo</th>
          <th>Member</th>
          <th>Banned</th>
          <th>Recorded by</th>
          <th>Notes</th>
          <th>Photo from</th>
          ${
            lifted
              ? html`<th>Lifted</th>
                  <th>Lifted by</th>
                  <th>Reason</th>`
              : ''
          }
          ${canLift ? html`<th>Lift</th>` : ''}
        </tr>
      </thead>
      <tbody>
        ${view.rows.map((row) =>
          banRowHtml(
            row,
            lifted,
            canLift ? liftForm(row, view.csrf) : undefined,
          ),
        )}
      </tbody>
    </table>
    ${pager}`;
}

/** Add one ban and import a CSV: Leadership only (display). */
function leaderForms(view: BannedTabView): SafeHtml {
  return html`<h2>Add a ban</h2>
    <form
      method="post"
      action="${localUrl(dashboardPath(DASHBOARD_PATHS.bans))}"
    >
      ${csrfField(view.csrf)}
      <label
        >Meetup member id
        <input
          name="memberId"
          inputmode="numeric"
          pattern="[0-9]{1,20}"
          autocomplete="off"
          required
      /></label>
      <label
        >Name
        <input name="memberName" maxlength="${BAN_NAME_MAX}" autocomplete="off"
      /></label>
      <label
        >Banned on (blank if unknown)
        <input type="date" name="bannedOn" min="2013-03-01" max="${view.today}"
      /></label>
      <label
        >Notes
        <textarea name="notes" rows="3" maxlength="${BAN_NOTES_MAX}"></textarea>
      </label>
      <button type="submit">Add ban</button>
    </form>
    <h2>Import bans</h2>
    <form
      method="post"
      action="${localUrl(dashboardPath(DASHBOARD_PATHS.banImport))}"
    >
      ${csrfField(view.csrf)}
      <p class="muted">
        Paste CSV text whose first line is exactly
        <code>${BAN_CSV_HEADER}</code>. banned_on may be blank. If any row is
        refused, nothing is imported.
      </p>
      <label
        >CSV
        <textarea name="csv" rows="6" required></textarea>
      </label>
      <button type="submit">Import bans</button>
    </form>`;
}

/** The Banned tab's content under the Suspensions tab nav. */
export function bannedTabBody(view: BannedTabView): SafeHtml {
  return html`${view.notice} ${showChoices(view.show, view.counts)}
    <p class="muted">
      Bans are recorded here only. Discord and Meetup access are changed by
      hand. A lifted ban keeps its photo.
    </p>
    ${bansTable(view)}
    ${
      view.leader
        ? leaderForms(view)
        : html`<p class="muted">
            Only the 1.5 Leadership Team can record, import, upload or lift a
            ban.
          </p>`
    }`;
}

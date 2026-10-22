import { BanRow, BanState } from '../../lib/bans/types.js';
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

export interface BannedTabView {
  show: BanState;
  rows: BanRow[];
  counts: Record<BanState, number>;
  page: number;
  notice: SafeHtml | '';
  /** The viewer may change bans (Task 5's forms). */
  leader: boolean;
  csrf: string;
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

function banRowHtml(row: BanRow, lifted: boolean): SafeHtml {
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
        </tr>
      </thead>
      <tbody>
        ${view.rows.map((row) => banRowHtml(row, lifted))}
      </tbody>
    </table>
    ${pager}`;
}

/** The Banned tab's content under the Suspensions tab nav. */
export function bannedTabBody(view: BannedTabView): SafeHtml {
  return html`${view.notice} ${showChoices(view.show, view.counts)}
    <p class="muted">
      Bans are recorded here only. Discord and Meetup access are changed by
      hand. A lifted ban keeps its photo.
    </p>
    ${bansTable(view)}`;
}

import dayjs from 'dayjs';
import express, { RequestHandler } from 'express';

import {
  IdentityNames,
  identityNameKey,
} from '../../lib/helpers/identity/names.js';
import {
  DASHBOARD_PATHS,
  dashboardPath,
} from '../../lib/reports/dashboardPaths.js';
import { GROUP_TIMEZONE } from '../../lib/reports/period.js';
import { IdentityChangeListItem } from '../../lib/repositories/postgresIdentityRepository.js';
import {
  IdentityField,
  IdentityPlatform,
} from '../../lib/repositories/identityTypes.js';
import { SafeHtml, html, localUrl, memberText, pageLink } from '../html.js';
import { sniffImageType } from '../images.js';
import { discordProfileUrl, memberLink } from '../links.js';
import {
  dashboardPage,
  load,
  notFound,
  pacificDateTime,
  unavailable,
} from '../pageKit.js';
import { PAGE_SIZE } from '../paging.js';
import type { DashboardPageDeps } from './dashboardPages.js';

const WHAT = 'Identity changes';
const SUBJECT_ID = /^[0-9]{1,20}$/;
/** At most 18 digits, so it always fits a bigint. */
const CHANGE_ID = /^[0-9]{1,18}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const PLATFORMS: readonly IdentityPlatform[] = ['discord', 'meetup'];
const PLATFORM_LABELS: Record<IdentityPlatform, string> = {
  discord: 'Discord',
  meetup: 'Meetup',
};
const FIELD_LABELS: Record<IdentityField, string> = {
  user_avatar: 'User avatar',
  member_avatar: 'Server avatar',
  nickname: 'Nickname',
  username: 'Username',
  global_name: 'Display name',
  photo: 'Profile photo',
  name: 'Name',
};
const IMAGE_FIELDS = new Set<IdentityField>([
  'user_avatar',
  'member_avatar',
  'photo',
]);

/** The page's query, validated. Every value is a plain string that passed its pattern, or undefined. */
interface IdentityQuery {
  platform?: IdentityPlatform;
  member?: string;
  from?: string;
  to?: string;
  before?: string;
}

/** A single query value (never an array) matching `pattern`. */
function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

/** YYYY-MM-DD naming a real calendar day (no 2026-02-30, no month 13). */
function calendarDay(value: unknown): string | undefined {
  const day = matching(value, DAY);
  if (day === undefined) {
    return undefined;
  }
  const [, y, m, d] = DAY.exec(day) ?? [];
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.toISOString().slice(0, 10) === day ? day : undefined;
}

/** Midnight Pacific at the start of `day`, `offsetDays` later. */
function pacificMidnight(day: string, offsetDays = 0): Date {
  const shifted = dayjs
    .utc(`${day}T00:00:00Z`)
    .add(offsetDays, 'day')
    .format('YYYY-MM-DD');
  return dayjs.tz(`${shifted}T00:00:00`, GROUP_TIMEZONE).toDate();
}

function parseQuery(query: Record<string, unknown>): IdentityQuery {
  return {
    platform: PLATFORMS.find((p) => p === query.platform),
    member: matching(query.member, SUBJECT_ID),
    from: calendarDay(query.from),
    to: calendarDay(query.to),
    before: matching(query.before, CHANGE_ID),
  };
}

/** The filters (not the cursor), for links that keep them. */
const filterParams = (q: IdentityQuery) => ({
  platform: q.platform,
  member: q.member,
  from: q.from,
  to: q.to,
});

const isValidDate = (v: unknown): v is Date =>
  v instanceof Date && !Number.isNaN(v.getTime());

const isOptionalText = (v: unknown): boolean =>
  v === null || v === undefined || typeof v === 'string';

/** A row this page can render; anything else is the 503 page, never a 500. */
function isListRow(row: unknown): row is IdentityChangeListItem {
  if (typeof row !== 'object' || row === null) {
    return false;
  }
  const r = row as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    PLATFORMS.some((p) => p === r.platform) &&
    typeof r.scopeId === 'string' &&
    typeof r.subjectId === 'string' &&
    typeof r.field === 'string' &&
    Object.prototype.hasOwnProperty.call(FIELD_LABELS, r.field) &&
    isOptionalText(r.oldValue) &&
    isOptionalText(r.newValue) &&
    (typeof r.source === 'string' || r.source === null) &&
    isValidDate(r.detectedAt) &&
    typeof r.hasOldThumb === 'boolean' &&
    typeof r.hasNewThumb === 'boolean'
  );
}

const thumbPath = (id: string, side: 'old' | 'new') =>
  `${dashboardPath(DASHBOARD_PATHS.identity)}/changes/${id}/thumb/${side}`;

/** The subject: a profile link from an all-digit id, the stored name escaped in <bdi>. */
function subjectCell(row: IdentityChangeListItem, name: string): SafeHtml {
  if (row.platform === 'meetup') {
    return memberLink({ id: row.subjectId, name });
  }
  const href = discordProfileUrl(row.subjectId);
  return href
    ? html`<a href="${href}" rel="noopener noreferrer" target="_blank"
        >${memberText(name)}</a
      >`
    : memberText(name);
}

function onlyThisMember(row: IdentityChangeListItem): SafeHtml | '' {
  if (!SUBJECT_ID.test(row.subjectId)) {
    return '';
  }
  const href = pageLink(dashboardPath(DASHBOARD_PATHS.identity), {
    platform: row.platform,
    member: row.subjectId,
  });
  return html`<br /><a href="${href}">Only this member</a>`;
}

/** One side of an image change: the stored thumbnail, by change id only. */
function thumb(
  row: IdentityChangeListItem,
  side: 'old' | 'new',
): SafeHtml | '' {
  const has = side === 'old' ? row.hasOldThumb : row.hasNewThumb;
  if (!has || !CHANGE_ID.test(row.id)) {
    return '';
  }
  // Lazy: the identity pool has two connections, and up to 100 thumbnails
  // per page would otherwise all queue on it at once.
  return html`<img
    src="${localUrl(thumbPath(row.id, side))}"
    width="64"
    height="64"
    alt="${side === 'old' ? 'before' : 'after'}"
    loading="lazy"
  />`;
}

function valueCell(row: IdentityChangeListItem, side: 'old' | 'new'): SafeHtml {
  if (IMAGE_FIELDS.has(row.field)) {
    const image = thumb(row, side);
    return image === ''
      ? html`<span class="muted">no image kept</span>`
      : image;
  }
  const value = side === 'old' ? row.oldValue : row.newValue;
  return memberText(value ?? '—');
}

function changeRow(
  row: IdentityChangeListItem,
  names: IdentityNames,
): SafeHtml {
  const name =
    names.get(identityNameKey(row.platform, row.scopeId, row.subjectId)) ??
    row.subjectId;
  return html`<tr>
    <td>${pacificDateTime(row.detectedAt)}</td>
    <td>${PLATFORM_LABELS[row.platform]}</td>
    <td>${subjectCell(row, name)}${onlyThisMember(row)}</td>
    <td>${FIELD_LABELS[row.field]}</td>
    <td>${valueCell(row, 'old')}</td>
    <td>${valueCell(row, 'new')}</td>
  </tr>`;
}

function platformOption(
  value: IdentityPlatform | '',
  label: string,
  current: IdentityPlatform | undefined,
): SafeHtml {
  return (current ?? '') === value
    ? html`<option value="${value}" selected>${label}</option>`
    : html`<option value="${value}">${label}</option>`;
}

function filterForm(q: IdentityQuery): SafeHtml {
  return html`<form
    method="get"
    action="${localUrl(dashboardPath(DASHBOARD_PATHS.identity))}"
    class="filters"
  >
    <label
      >Platform
      <select name="platform">
        ${platformOption('', 'Both', q.platform)}
        ${PLATFORMS.map((p) => platformOption(p, PLATFORM_LABELS[p], q.platform))}
      </select>
    </label>
    <label
      >Member id
      <input
        name="member"
        value="${q.member ?? ''}"
        inputmode="numeric"
        maxlength="20"
        autocomplete="off"
      />
    </label>
    <label
      >From <input type="date" name="from" value="${q.from ?? ''}"
    /></label>
    <label>To <input type="date" name="to" value="${q.to ?? ''}" /></label>
    <button type="submit">Filter</button>
  </form>`;
}

function pager(q: IdentityQuery, rows: IdentityChangeListItem[]): SafeHtml {
  const path = dashboardPath(DASHBOARD_PATHS.identity);
  const last = rows[rows.length - 1];
  const older =
    rows.length === PAGE_SIZE && last && CHANGE_ID.test(last.id)
      ? html`<a
          href="${pageLink(path, { ...filterParams(q), before: last.id })}"
          >Older changes</a
        >`
      : '';
  const newest =
    q.before !== undefined
      ? html`<a href="${pageLink(path, filterParams(q))}">Newest changes</a>`
      : '';
  return html`<nav class="pager">${newest} ${older}</nav>`;
}

function changesTable(
  q: IdentityQuery,
  rows: IdentityChangeListItem[],
  names: IdentityNames,
): SafeHtml {
  if (rows.length === 0) {
    return html`<p>No identity changes match these filters.</p>
      ${pager(q, rows)}`;
  }
  return html`<table>
      <thead>
        <tr>
          <th>Detected (Pacific)</th>
          <th>Platform</th>
          <th>Member</th>
          <th>Field</th>
          <th>Before</th>
          <th>After</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => changeRow(row, names))}
      </tbody>
    </table>
    ${pager(q, rows)}`;
}

export function registerIdentityRoutes(
  router: express.Router,
  deps: Pick<DashboardPageDeps, 'identity'>,
): void {
  router.get(DASHBOARD_PATHS.identity, (async (req, res) => {
    const q = parseQuery(req.query);
    const loaded = await load(res, WHAT, async () => {
      const reader = await deps.identity();
      const rows = await reader.listChangesPage({
        from: q.from === undefined ? undefined : pacificMidnight(q.from),
        // Inclusive day: up to the next day's Pacific midnight.
        to: q.to === undefined ? undefined : pacificMidnight(q.to, 1),
        platform: q.platform,
        subjectId: q.member,
        beforeId: q.before,
        limit: PAGE_SIZE,
      });
      if (!Array.isArray(rows) || !rows.every(isListRow)) {
        return undefined;
      }
      const names = await reader.listIdentityNames(
        rows.map((r) => ({
          platform: r.platform,
          scopeId: r.scopeId,
          subjectId: r.subjectId,
        })),
      );
      return { rows, names };
    });
    if (!loaded.ok) {
      return;
    }
    if (loaded.value === undefined || !(loaded.value.names instanceof Map)) {
      unavailable(res, WHAT);
      return;
    }
    const { rows, names } = loaded.value;
    dashboardPage(res, {
      title: 'Identity changes',
      body: html`<div class="card">
        <h1>Identity changes</h1>
        <p class="muted">
          Name and picture changes on Discord and Meetup, newest first. Dates
          are Pacific; the "To" day is included.
        </p>
        ${filterForm(q)} ${changesTable(q, rows, names)}
      </div>`,
    });
  }) as RequestHandler);

  // One thumbnail per request: one column of one row, by change id and side
  // only. The type comes from the bytes; anything that is not PNG, JPEG or
  // WebP is a 404 page, never the bytes.
  router.get(DASHBOARD_PATHS.identityThumb, (async (req, res) => {
    const { id, side } = req.params;
    if (
      typeof id !== 'string' ||
      !CHANGE_ID.test(id) ||
      (side !== 'old' && side !== 'new')
    ) {
      notFound(res);
      return;
    }
    // An abandoned request (a lazy image scrolled past, a closed tab): do
    // not queue it on the identity pool's two connections.
    if (req.socket?.destroyed) {
      return;
    }
    const loaded = await load(res, 'The image', async () =>
      (await deps.identity()).getChangeThumb(id, side),
    );
    if (!loaded.ok) {
      return;
    }
    const bytes = loaded.value;
    const type = Buffer.isBuffer(bytes) ? sniffImageType(bytes) : undefined;
    if (!Buffer.isBuffer(bytes) || type === undefined) {
      notFound(res);
      return;
    }
    // no-store and nosniff also come from baseSecurityHeaders; restated so
    // this route cannot lose them. setHeader, not res.type/res.set: Express
    // adds a charset to some types, and nothing here may infer one.
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.end(bytes);
  }) as RequestHandler);
}

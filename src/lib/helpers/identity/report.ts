import {
  IdentityChangeRecord,
  IdentityField,
  IdentityPlatform,
} from '../../repositories/identityTypes.js';
import {
  IdentityNames,
  displayNameFor,
  meetupDisplayNameFor,
  meetupProfileUrl,
} from './names.js';

/**
 * Sized to the DYNO, not to Discord's upload limit.
 *
 * The guild is boost tier 3, so Discord would accept 100 MB -- but producing
 * such a file means the rows with both BYTEA thumbs, the base64 expansion, an
 * intermediate array, one mega-string and then writeFileSync's copy all live
 * at once, roughly 3-4x the raw bytes, on a 512 MB dyno with an R14 history.
 * 10 MB of thumbnails is a report an organizer can actually open and a peak
 * this process survives.
 */
export const MAX_REPORT_BYTES = 10 * 1024 * 1024;

const FIELD_LABELS: Record<IdentityField, string> = {
  user_avatar: 'User avatar',
  member_avatar: 'Server avatar',
  nickname: 'Nickname',
  username: 'Username',
  global_name: 'Display name',
  photo: 'Profile photo',
  name: 'Name',
};

// The Platform column already says which service a row is from, so these
// stay short rather than repeating "Meetup"/"Discord" inside the field name.
const PLATFORM_LABELS: Record<IdentityPlatform, string> = {
  discord: 'Discord',
  meetup: 'Meetup',
};

function escapeHtml(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Determines the media type from the bytes rather than assuming one.
 *
 * The report hardcoded `image/webp`, which was true only of Discord's CDN.
 * Meetup's thumbnails are JPEG, so every Meetup photo change rendered as a
 * broken image in a document whose entire purpose is showing organizers the
 * before and after. Sniffing keeps the report correct for whatever a future
 * source returns instead of encoding one CDN's current behaviour.
 */
function mimeOf(thumb: Buffer): string {
  if (thumb.length >= 2 && thumb[0] === 0xff && thumb[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (thumb.length >= 2 && thumb[0] === 0x89 && thumb[1] === 0x50) {
    return 'image/png';
  }
  if (
    thumb.length >= 12 &&
    thumb.toString('ascii', 0, 4) === 'RIFF' &&
    thumb.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/webp';
}

function img(thumb: Buffer | null): string {
  if (!thumb) {
    return '<span class="none">no image</span>';
  }
  return `<img src="data:${mimeOf(thumb)};base64,${thumb.toString(
    'base64',
  )}" alt="">`;
}

/**
 * Renders the Member cell.
 *
 * Same promise as the digest: a row says WHO, not just which id. A Discord
 * member shows their stored name with the user id alongside; a Meetup member
 * shows their name as a link to their Meetup profile, the raw Meetup id (it
 * is what survives a rename and what an organizer searches with), and the
 * linked Discord user id where the link table has one. Discord mention
 * markup is useless in a static HTML file, so ids render as text.
 *
 * Names are attacker-controlled and are HTML-escaped; the href is built only
 * from a numeric id (see meetupProfileUrl).
 */
// <bdi> isolates the name's direction, so a bidi override inside it cannot
// visually reorder the id rendered beside it.
function bdi(name: string): string {
  return `<bdi>${escapeHtml(name)}</bdi>`;
}

function memberCell(
  change: IdentityChangeRecord,
  meetupToDiscord: Map<string, string>,
  names: IdentityNames,
): string {
  const id = escapeHtml(change.subjectId);
  if (change.platform === 'discord') {
    const name = displayNameFor(change, names);
    return name ? `${bdi(name)} <span class="raw">(${id})</span>` : id;
  }
  const name = meetupDisplayNameFor(change, names);
  const url = meetupProfileUrl(change.subjectId);
  const text = name ? bdi(name) : id;
  const member = url
    ? `<a href="${url}" rel="noopener noreferrer">${text}</a>`
    : text;
  const rawId = name ? ` <span class="raw">(Meetup ${id})</span>` : '';
  const discordUserId = meetupToDiscord.get(change.subjectId);
  const linked = discordUserId ? ` · Discord ${escapeHtml(discordUserId)}` : '';
  return `${member}${rawId}${linked}`;
}

/**
 * Base64 inflates by 4/3; the markup around each row is up to roughly 500
 * bytes (a named Meetup row carries a profile link, the name and both ids).
 *
 * Takes counts rather than rows so the command can ask Postgres for
 * `count(*)` and `sum(octet_length(...))` and refuse an oversized range
 * BEFORE loading a single thumbnail into the dyno.
 */
export function estimateReportBytesFromCounts(
  changeCount: number,
  thumbBytes: number,
): number {
  return Math.ceil((thumbBytes * 4) / 3) + changeCount * 500 + 2048;
}

/** In-memory equivalent, used as a backstop once rows are already loaded. */
export function estimateReportBytes(changes: IdentityChangeRecord[]): number {
  const thumbBytes = changes.reduce(
    (total, change) =>
      total + (change.oldThumb?.length ?? 0) + (change.newThumb?.length ?? 0),
    0,
  );
  return estimateReportBytesFromCounts(changes.length, thumbBytes);
}

export function renderIdentityReport(
  changes: IdentityChangeRecord[],
  range: { from: Date; to: Date },
  // Defaulted so a caller with no link table still renders raw ids rather
  // than throwing -- the documented fallback, not a new failure mode.
  meetupToDiscord: Map<string, string> = new Map(),
  names: IdentityNames = new Map(),
): string {
  const header = `Identity changes ${range.from
    .toISOString()
    .slice(0, 10)} to ${range.to.toISOString().slice(0, 10)}`;

  const body =
    changes.length === 0
      ? '<p class="none">No identity changes in this range.</p>'
      : `<table>
<thead><tr><th>When (UTC)</th><th>Platform</th><th>Member</th><th>Field</th><th>Before</th><th>After</th><th>Source</th></tr></thead>
<tbody>
${changes
  .map((change) => {
    // Avatar/photo fields always render as image cells, even when the thumb
    // is null (CDN fetch failed, or Meetup's old-photo URL is unrecoverable):
    // img() renders a "no image" placeholder for null. Non-photo fields
    // (nickname, username, name, ...) never have thumbs at all, so they
    // render their text value.
    const isAvatarField =
      change.field === 'user_avatar' ||
      change.field === 'member_avatar' ||
      change.field === 'photo';
    return `<tr>
<td class="when">${change.detectedAt.toISOString().replace('T', ' ').slice(0, 16)}</td>
<td>${escapeHtml(PLATFORM_LABELS[change.platform])}</td>
<td class="who">${memberCell(change, meetupToDiscord, names)}</td>
<td>${escapeHtml(FIELD_LABELS[change.field])}</td>
<td>${isAvatarField ? img(change.oldThumb) : escapeHtml(change.oldValue)}</td>
<td>${isAvatarField ? img(change.newThumb) : escapeHtml(change.newValue)}</td>
<td>${escapeHtml(change.source)}</td>
</tr>`;
  })
  .join('\n')}
</tbody></table>`;

  // Self-contained by design: no external stylesheet, script, font or image.
  // The file must render identically offline and in a year's time.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(header)}</title>
<style>
body{font:14px system-ui,sans-serif;margin:24px;color:#111;background:#fff}
h1{font-size:18px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:middle}
th{background:#f5f5f5}
img{width:64px;height:64px;object-fit:cover;border-radius:4px;display:block}
.when{white-space:nowrap;font-variant-numeric:tabular-nums}
.who{font-family:ui-monospace,monospace;font-size:12px}
.raw{color:#888}
.none{color:#888;font-style:italic}
</style></head>
<body>
<h1>${escapeHtml(header)}</h1>
<p>${changes.length} change${changes.length === 1 ? '' : 's'}.</p>
${body}
</body></html>`;
}

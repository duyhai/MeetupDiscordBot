import {
  IdentityChangeRecord,
  IdentityField,
} from '../repositories/identityTypes.js';

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
};

function escapeHtml(value: string | null): string {
  if (value === null) {
    return '—';
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function img(thumb: Buffer | null): string {
  if (!thumb) {
    return '<span class="none">no image</span>';
  }
  return `<img src="data:image/webp;base64,${thumb.toString('base64')}" alt="">`;
}

/**
 * Base64 inflates by 4/3; the markup around each row is roughly 300 bytes.
 *
 * Takes counts rather than rows so the command can ask Postgres for
 * `count(*)` and `sum(octet_length(...))` and refuse an oversized range
 * BEFORE loading a single thumbnail into the dyno.
 */
export function estimateReportBytesFromCounts(
  changeCount: number,
  thumbBytes: number,
): number {
  return Math.ceil((thumbBytes * 4) / 3) + changeCount * 300 + 2048;
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
): string {
  const header = `Identity changes ${range.from
    .toISOString()
    .slice(0, 10)} to ${range.to.toISOString().slice(0, 10)}`;

  const body =
    changes.length === 0
      ? '<p class="none">No identity changes in this range.</p>'
      : `<table>
<thead><tr><th>When (UTC)</th><th>Member</th><th>Field</th><th>Before</th><th>After</th><th>Source</th></tr></thead>
<tbody>
${changes
  .map((change) => {
    // Avatar fields always render as image cells, even when the thumb is
    // null (CDN fetch failed): img() renders a "no image" placeholder for
    // null. Non-avatar fields (nickname, username, ...) never have thumbs
    // at all, so they render their text value.
    const isAvatarField =
      change.field === 'user_avatar' || change.field === 'member_avatar';
    return `<tr>
<td class="when">${change.detectedAt.toISOString().replace('T', ' ').slice(0, 16)}</td>
<td class="who">${escapeHtml(change.discordUserId)}</td>
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
.none{color:#888;font-style:italic}
</style></head>
<body>
<h1>${escapeHtml(header)}</h1>
<p>${changes.length} change${changes.length === 1 ? '' : 's'}.</p>
${body}
</body></html>`;
}

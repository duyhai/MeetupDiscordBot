/**
 * Server-side HTML for the staff dashboard. Every interpolated value is
 * escaped unless it is already SafeHtml, so a page can only emit markup it
 * wrote itself: member names, event titles and notes are attacker-controlled.
 */
export class SafeHtml {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

export type HtmlValue =
  SafeHtml | string | number | null | undefined | false | HtmlValue[];

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(render).join('');
  }
  if (value instanceof SafeHtml) {
    return value.value;
  }
  return escapeHtml(String(value));
}

export function html(
  strings: TemplateStringsArray,
  ...values: HtmlValue[]
): SafeHtml {
  let out = strings[0];
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1];
  });
  return new SafeHtml(out);
}

/**
 * Member-supplied text: escaped, and wrapped in <bdi> so a right-to-left
 * override in a name cannot reorder the text around it.
 */
export function memberText(text: string): SafeHtml {
  return html`<bdi>${text}</bdi>`;
}

const LINK_TARGETS = [
  { host: 'www.meetup.com', pathPrefix: '/' },
  { host: 'discord.com', pathPrefix: '/users/' },
];

/**
 * Exact-path targets: Meetup's OAuth authorize endpoint, for the "Renew
 * organizer login" continue link. Any query is allowed; no other path is.
 */
const EXACT_LINK_TARGETS = [
  { host: 'secure.meetup.com', pathname: '/oauth2/authorize' },
];

/**
 * The only outbound links a dashboard page may render. Event URLs and
 * profile URLs come from Meetup data, so they are checked here rather than
 * trusted: anything that isn't plain https to one of these places is
 * dropped, and the caller renders the text without a link.
 */
export function safeHref(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    return undefined;
  }
  const allowed =
    LINK_TARGETS.some(
      ({ host, pathPrefix }) =>
        parsed.hostname === host && parsed.pathname.startsWith(pathPrefix),
    ) ||
    EXACT_LINK_TARGETS.some(
      ({ host, pathname }) =>
        parsed.hostname === host && parsed.pathname === pathname,
    );
  return allowed ? parsed.href : undefined;
}

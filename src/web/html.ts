/**
 * Server-side HTML for the staff dashboard. Every interpolated value is
 * escaped unless it is already SafeHtml, so a page can only emit markup it
 * wrote itself: member names, event titles and notes are attacker-controlled.
 *
 * SafeHtml and SafeUrl are brands minted only in this module: each is keyed
 * by an unexported unique symbol, so no object literal satisfies the type,
 * and a module-private WeakSet records every minted value, so a look-alike
 * object is rendered as text at runtime.
 */
declare const htmlBrand: unique symbol;
declare const urlBrand: unique symbol;

export interface SafeHtml {
  readonly value: string;
  toString(): string;
  readonly [htmlBrand]: true;
}

export interface SafeUrl {
  readonly href: string;
  toString(): string;
  readonly [urlBrand]: true;
}

export type HtmlValue =
  SafeHtml | SafeUrl | string | number | null | undefined | false | HtmlValue[];

const minted = new WeakSet<object>();

function mintHtml(value: string): SafeHtml {
  const out = Object.freeze({
    value,
    toString: () => value,
  }) as unknown as SafeHtml;
  minted.add(out);
  return out;
}

function mintUrl(href: string): SafeUrl {
  const out = Object.freeze({
    href,
    toString: () => href,
  }) as unknown as SafeUrl;
  minted.add(out);
  return out;
}

export function isSafeHtml(value: unknown): value is SafeHtml {
  return (
    typeof value === 'object' &&
    value !== null &&
    minted.has(value) &&
    'value' in value
  );
}

export function isSafeUrl(value: unknown): value is SafeUrl {
  return (
    typeof value === 'object' &&
    value !== null &&
    minted.has(value) &&
    'href' in value
  );
}

export class UnsafeUrlError extends Error {
  constructor(attribute: string) {
    super(`${attribute} takes exactly one SafeUrl as its whole quoted value`);
    this.name = 'UnsafeUrlError';
  }
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The template text before an interpolation ends inside a URL attribute:
 * `href="` (the value starts here), `href="/x/` (partial: refused) or
 * `href=` (unquoted: refused). `xlink:href` counts too, for inline SVG.
 */
const URL_ATTR =
  /[\s:](href|src|action|formaction)\s*=\s*(?:"([^"]*)|'([^']*)|())$/i;

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(render).join('');
  }
  if (isSafeHtml(value)) {
    return value.value;
  }
  if (isSafeUrl(value)) {
    return escapeHtml(value.href);
  }
  // A forged look-alike object is text, never markup.
  return escapeHtml(String(value));
}

/**
 * Every interpolation into href, src, action or formaction must be exactly
 * one SafeUrl filling the whole quoted value; anything else (a string, a
 * SafeHtml, undefined, part of a value, an unquoted value) throws
 * UnsafeUrlError, so a javascript: URL cannot be rendered by accident.
 */
export function html(
  strings: TemplateStringsArray,
  ...values: HtmlValue[]
): SafeHtml {
  let out = strings[0];
  values.forEach((value, i) => {
    const attr = URL_ATTR.exec(strings[i]);
    if (attr) {
      const opened = attr[2] ?? attr[3];
      const after = strings[i + 1];
      let quote: string | undefined;
      if (attr[2] !== undefined) {
        quote = '"';
      } else if (attr[3] !== undefined) {
        quote = "'";
      }
      if (
        quote === undefined ||
        opened !== '' ||
        !after.startsWith(quote) ||
        !isSafeUrl(value)
      ) {
        throw new UnsafeUrlError(attr[1]);
      }
    }
    out += render(value) + strings[i + 1];
  });
  return mintHtml(out);
}

/** Markup written in this codebase, with no interpolation at all (CSS, the copy script). */
export function staticHtml(strings: TemplateStringsArray): SafeHtml {
  // A real template literal's strings array is frozen and carries `raw`;
  // one entry means nothing was interpolated.
  if (
    strings?.length !== 1 ||
    !Object.isFrozen(strings) ||
    !Array.isArray(strings.raw)
  ) {
    throw new TypeError(
      'staticHtml takes a template literal without interpolation',
    );
  }
  return mintHtml(strings[0]);
}

const LOCAL_PATH =
  /^\/dashboard(\/[A-Za-z0-9._~%-]+)*\/?(\?[A-Za-z0-9._~%&=+-]*)?$/;
/** A '.' or '..' segment, literal or percent-encoded (browsers decode %2e). */
const DOT_SEGMENT = /\/(?:\.|%2e){1,2}(?=\/|\?|$)/i;

/** Our own pages: /dashboard paths only; no dot segment, no '//', no scheme, no quotes. */
export function localUrl(pathAndQuery: string): SafeUrl {
  if (
    typeof pathAndQuery !== 'string' ||
    !LOCAL_PATH.test(pathAndQuery) ||
    DOT_SEGMENT.test(pathAndQuery.split('?')[0])
  ) {
    throw new RangeError('not a dashboard path');
  }
  return mintUrl(pathAndQuery);
}

/**
 * localUrl with a query built by URLSearchParams; undefined and empty values
 * are left out. URLSearchParams leaves '*' bare, which the local-path
 * charset refuses, so it is encoded as %2A.
 */
export function pageLink(
  path: string,
  params: Record<string, string | undefined> = {},
): SafeUrl {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      query.set(key, value);
    }
  });
  const qs = query.toString().replace(/\*/g, '%2A');
  return localUrl(qs ? `${path}?${qs}` : path);
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
export function safeHref(url: string): SafeUrl | undefined {
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
  return allowed ? mintUrl(parsed.href) : undefined;
}

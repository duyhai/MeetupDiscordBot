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

// One registry per brand: membership alone decides, never a property
// lookup that a polluted Object.prototype could answer.
const mintedHtml = new WeakSet<object>();
const mintedUrls = new WeakSet<object>();

function mintHtml(value: string): SafeHtml {
  // No fragment may end inside a URL attribute's value: whatever follows it
  // would land in the URL unchecked.
  const end = tagState(value);
  if (end.kind === 'quoted' && isUrlAttr(end.attr)) {
    throw new UnsafeUrlError(end.attr);
  }
  const out = Object.freeze({
    value,
    toString: () => value,
  }) as unknown as SafeHtml;
  mintedHtml.add(out);
  return out;
}

function mintUrl(href: string): SafeUrl {
  const out = Object.freeze({
    href,
    toString: () => href,
  }) as unknown as SafeUrl;
  mintedUrls.add(out);
  return out;
}

export function isSafeHtml(value: unknown): value is SafeHtml {
  return typeof value === 'object' && value !== null && mintedHtml.has(value);
}

export function isSafeUrl(value: unknown): value is SafeUrl {
  return typeof value === 'object' && value !== null && mintedUrls.has(value);
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

export class UnsafeAttributeError extends Error {
  constructor(where: string) {
    super(`html cannot interpolate ${where}`);
    this.name = 'UnsafeAttributeError';
  }
}

/** Attributes whose value is fetched or navigated to: SafeUrl only. */
const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'srcset',
  'poster',
  'data',
  'ping',
  'background',
  'cite',
]);

/** `xlink:href` and the like count as their local name. */
const isUrlAttr = (name: string) =>
  URL_ATTRS.has(name.toLowerCase().split(':').pop() ?? '');

/** Where the end of some markup sits, for the next interpolation. */
type TagState =
  | { kind: 'text' }
  | { kind: 'name' } // tag name or attribute-name position
  | { kind: 'unquoted'; attr: string } // after `attr=`, or inside a bare value
  | { kind: 'quoted'; attr: string; quote: string; opened: string };

const WS = /[\s]/;

/**
 * Scans from the last `<` to the end of `text`, the way a browser tokenizes
 * a start tag: tag name, then attributes separated by whitespace or `/`,
 * each optionally `= value` (double-, single- or unquoted). A quoted `>`
 * does not end the tag. Escaped text never contains `<`, `>` or quotes, so
 * only markup this module minted steers the scan. Anything it cannot place
 * is reported as `name`, which callers refuse (fail closed).
 */
function tagState(text: string): TagState {
  const start = text.lastIndexOf('<');
  if (start === -1) {
    return { kind: 'text' };
  }
  const s = text.slice(start + 1);
  if (s.startsWith('!')) {
    // A comment or doctype. Its end decides; a `>` closes it.
    return s.includes('>') ? { kind: 'text' } : { kind: 'name' };
  }
  let i = 0;
  while (i < s.length && !WS.test(s[i]) && s[i] !== '>' && s[i] !== '/') {
    i += 1;
  }
  for (;;) {
    while (i < s.length && (WS.test(s[i]) || s[i] === '/')) {
      i += 1;
    }
    if (i >= s.length) {
      return { kind: 'name' };
    }
    if (s[i] === '>') {
      // The tag closed; text follows. Only the last `<` matters.
      return { kind: 'text' };
    }
    const nameStart = i;
    while (i < s.length && !WS.test(s[i]) && !'"\'>/='.includes(s[i])) {
      i += 1;
    }
    const attr = s.slice(nameStart, i);
    if (i === nameStart) {
      // A stray quote where a name should be.
      return { kind: 'name' };
    }
    let j = i;
    while (j < s.length && WS.test(s[j])) {
      j += 1;
    }
    if (j >= s.length) {
      return { kind: 'name' };
    }
    if (s[j] !== '=') {
      // A boolean attribute; the next one starts here.
      continue;
    }
    j += 1;
    while (j < s.length && WS.test(s[j])) {
      j += 1;
    }
    if (j >= s.length) {
      return { kind: 'unquoted', attr };
    }
    const quote = s[j];
    if (quote === '"' || quote === "'") {
      const close = s.indexOf(quote, j + 1);
      if (close === -1) {
        return { kind: 'quoted', attr, quote, opened: s.slice(j + 1) };
      }
      i = close + 1;
      continue;
    }
    while (j < s.length && !WS.test(s[j]) && s[j] !== '>') {
      j += 1;
    }
    if (j >= s.length) {
      return { kind: 'unquoted', attr };
    }
    i = j;
  }
}

/** Template strings arrays already checked; a call site reuses its array. */
const templates = new WeakSet<object>();

/**
 * True only for a strings array shaped like the one the engine passes to a
 * tag: a frozen array whose own `raw` is non-enumerable, non-writable,
 * non-configurable and a frozen array of strings of the same length.
 * Object.assign([evil], { raw }) fails (raw is enumerable), with or without
 * Object.freeze. A caller who rebuilds every one of those properties by hand
 * is not stopped here; the no-restricted-syntax lint rule, which allows these
 * tags only as tagged templates, covers that.
 */
function isTemplateStrings(strings: unknown): strings is TemplateStringsArray {
  if (typeof strings !== 'object' || strings === null) {
    return false;
  }
  if (templates.has(strings)) {
    return true;
  }
  if (!Array.isArray(strings) || !Object.isFrozen(strings)) {
    return false;
  }
  const raw = Object.getOwnPropertyDescriptor(strings, 'raw');
  const value: unknown = raw?.value;
  const ok =
    raw !== undefined &&
    !raw.enumerable &&
    !raw.writable &&
    !raw.configurable &&
    Array.isArray(value) &&
    Object.isFrozen(value) &&
    value.length === strings.length &&
    value.every((part) => typeof part === 'string') &&
    strings.every((part) => typeof part === 'string' || part === undefined);
  if (ok) {
    templates.add(strings);
  }
  return ok;
}

function requireTemplate(strings: unknown, tag: string): void {
  if (!isTemplateStrings(strings)) {
    throw new TypeError(`${tag} must be used as a tagged template`);
  }
}

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
 * Every interpolation into a URL attribute (URL_ATTRS, by local name) must
 * be exactly one SafeUrl filling the whole quoted value; anything else (a
 * string, a SafeHtml, undefined, part of a value, an unquoted value) throws
 * UnsafeUrlError, so a javascript: URL cannot be rendered by accident. An
 * interpolation in tag- or attribute-name position, or into any unquoted
 * value, throws UnsafeAttributeError.
 */
export function html(
  strings: TemplateStringsArray,
  ...values: HtmlValue[]
): SafeHtml {
  requireTemplate(strings, 'html');
  let out = strings[0];
  values.forEach((value, i) => {
    // The whole output so far, not just this literal: a fragment
    // interpolated earlier may have opened the tag.
    const at = tagState(out);
    const after = strings[i + 1];
    if (at.kind === 'name') {
      throw new UnsafeAttributeError('in a tag or attribute name');
    }
    if (at.kind === 'unquoted') {
      if (isUrlAttr(at.attr)) {
        throw new UnsafeUrlError(at.attr);
      }
      throw new UnsafeAttributeError(`into unquoted ${at.attr}`);
    }
    if (
      at.kind === 'quoted' &&
      isUrlAttr(at.attr) &&
      (at.opened !== '' || !after.startsWith(at.quote) || !isSafeUrl(value))
    ) {
      throw new UnsafeUrlError(at.attr);
    }
    out += render(value) + after;
  });
  return mintHtml(out);
}

/** Markup written in this codebase, with no interpolation at all (CSS, the copy script). */
export function staticHtml(strings: TemplateStringsArray): SafeHtml {
  requireTemplate(strings, 'staticHtml');
  // One entry means nothing was interpolated.
  if (strings.length !== 1) {
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

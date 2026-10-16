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
/** SafeHtml written as a constant (staticHtml): the only thing a script or style body may take. */
const mintedStatic = new WeakSet<object>();

function mintHtml(value: string, isStatic = false): SafeHtml {
  const out = Object.freeze({
    value,
    toString: () => value,
  }) as unknown as SafeHtml;
  mintedHtml.add(out);
  if (isStatic) {
    mintedStatic.add(out);
  }
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

/**
 * Elements whose content is not markup. In raw text (script, style and
 * friends) nothing may be interpolated except a constant staticHtml body;
 * in RCDATA (textarea, title) escaped text is fine, markup is not.
 */
const RAW_TEXT = new Set([
  'script',
  'style',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
]);
const RCDATA = new Set(['textarea', 'title']);

type Mode =
  | 'text'
  | 'tagOpen' // just after `<`
  | 'endTagOpen' // just after `</`
  | 'tagName'
  | 'markup' // after `<!`, deciding comment or doctype
  | 'comment'
  | 'bogus' // `<!doctype …>`, `<?…>`: ends at `>`
  | 'beforeAttr'
  | 'attrName'
  | 'afterAttrName'
  | 'beforeValue'
  | 'quoted'
  | 'unquoted'
  | 'afterQuoted'
  | 'raw'; // raw text or RCDATA, until `</tag`

/**
 * The HTML tokenizer's state, carried forward from the start of a template
 * across its literals and the values put between them. Only what the
 * interpolation rules need is kept.
 */
interface Scan {
  mode: Mode;
  /** The open tag's lower-case name. */
  tag: string;
  /** Inside an end tag (`</p …>`). */
  endTag: boolean;
  /** The current attribute's name, as written. */
  attr: string;
  quote: string;
  /** Nothing has been written into the quoted value yet. */
  empty: boolean;
  /** Raw text: `</tag` matched so far; RCDATA vs raw text. */
  match: number;
  rcdata: boolean;
  /** Comment: `-` just seen; `markup`: what followed `<!`. */
  dashes: number;
  seen: string;
}

const newScan = (): Scan => ({
  mode: 'text',
  tag: '',
  endTag: false,
  attr: '',
  quote: '',
  empty: true,
  match: 0,
  rcdata: false,
  dashes: 0,
  seen: '',
});

const isSpace = (ch: string) =>
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
const isLetter = (ch: string) => /[A-Za-z]/.test(ch);

/** The `>` that ends a tag: a start tag of a raw-text element opens raw text. */
function closeTag(st: Scan): void {
  if (!st.endTag && (RAW_TEXT.has(st.tag) || RCDATA.has(st.tag))) {
    st.mode = 'raw';
    st.rcdata = RCDATA.has(st.tag);
    st.match = 0;
    return;
  }
  st.mode = 'text';
}

function startAttr(st: Scan, ch: string): void {
  st.mode = 'attrName';
  st.attr = ch;
}

/**
 * One character of the HTML tokenizer (WHATWG 13.2.5, reduced to the states
 * that decide where an interpolation lands). Forward only: a `<`, `>` or
 * comment opener inside a quoted value is just part of the value.
 */
function step(st: Scan, ch: string): void {
  switch (st.mode) {
    case 'text':
      if (ch === '<') {
        st.mode = 'tagOpen';
      }
      return;
    case 'tagOpen':
      if (isLetter(ch)) {
        st.mode = 'tagName';
        st.tag = ch.toLowerCase();
        st.endTag = false;
      } else if (ch === '/') {
        st.mode = 'endTagOpen';
      } else if (ch === '!') {
        st.mode = 'markup';
        st.seen = '';
      } else if (ch === '?') {
        st.mode = 'bogus';
      } else if (ch !== '<') {
        st.mode = 'text';
      }
      return;
    case 'endTagOpen':
      if (isLetter(ch)) {
        st.mode = 'tagName';
        st.tag = ch.toLowerCase();
        st.endTag = true;
      } else {
        st.mode = ch === '>' ? 'text' : 'bogus';
      }
      return;
    case 'tagName':
      if (isSpace(ch) || ch === '/') {
        st.mode = 'beforeAttr';
      } else if (ch === '>') {
        closeTag(st);
      } else {
        st.tag += ch.toLowerCase();
      }
      return;
    case 'markup':
      st.seen += ch;
      if (st.seen === '--') {
        // `<!-->` and `<!--->` close at once, as browsers do.
        st.mode = 'comment';
        st.dashes = 2;
      } else if (st.seen !== '-') {
        st.mode = ch === '>' ? 'text' : 'bogus';
      }
      return;
    case 'comment':
      if (ch === '-') {
        st.dashes += 1;
      } else if (ch === '>' && st.dashes >= 2) {
        st.mode = 'text';
      } else {
        st.dashes = 0;
      }
      return;
    case 'bogus':
      if (ch === '>') {
        st.mode = 'text';
      }
      return;
    case 'beforeAttr':
      if (ch === '>') {
        closeTag(st);
      } else if (!isSpace(ch) && ch !== '/') {
        startAttr(st, ch);
      }
      return;
    case 'attrName':
      if (isSpace(ch)) {
        st.mode = 'afterAttrName';
      } else if (ch === '/') {
        st.mode = 'beforeAttr';
      } else if (ch === '=') {
        st.mode = 'beforeValue';
      } else if (ch === '>') {
        closeTag(st);
      } else {
        st.attr += ch;
      }
      return;
    case 'afterAttrName':
      if (ch === '/') {
        st.mode = 'beforeAttr';
      } else if (ch === '=') {
        st.mode = 'beforeValue';
      } else if (ch === '>') {
        closeTag(st);
      } else if (!isSpace(ch)) {
        startAttr(st, ch);
      }
      return;
    case 'beforeValue':
      if (ch === '"' || ch === "'") {
        st.mode = 'quoted';
        st.quote = ch;
        st.empty = true;
      } else if (ch === '>') {
        closeTag(st);
      } else if (!isSpace(ch)) {
        st.mode = 'unquoted';
      }
      return;
    case 'quoted':
      if (ch === st.quote) {
        st.mode = 'afterQuoted';
      } else {
        st.empty = false;
      }
      return;
    case 'unquoted':
      if (isSpace(ch)) {
        st.mode = 'beforeAttr';
      } else if (ch === '>') {
        closeTag(st);
      }
      return;
    case 'afterQuoted':
      if (isSpace(ch) || ch === '/') {
        st.mode = 'beforeAttr';
      } else if (ch === '>') {
        closeTag(st);
      } else {
        startAttr(st, ch);
      }
      return;
    case 'raw': {
      const target = `</${st.tag}`;
      if (st.match === target.length) {
        // `</tag` seen: it ends the element only if the name ends here.
        if (isSpace(ch) || ch === '/') {
          st.mode = 'beforeAttr';
          st.endTag = true;
          return;
        }
        if (ch === '>') {
          st.mode = 'text';
          return;
        }
        st.match = 0;
      }
      if (ch.toLowerCase() === target[st.match]) {
        st.match += 1;
      } else {
        st.match = ch === '<' ? 1 : 0;
      }
      return;
    }
    default:
      return;
  }
}

function feed(st: Scan, text: string): void {
  for (const ch of text) {
    step(st, ch);
  }
}

/** A minted fragment must end where it began, in text: never inside a tag, comment or raw text. */
function requireTextEnd(st: Scan): void {
  if (st.mode === 'text') {
    return;
  }
  if (st.mode === 'quoted' && isUrlAttr(st.attr)) {
    throw new UnsafeUrlError(st.attr);
  }
  throw new UnsafeAttributeError(
    'here: a fragment must end outside any tag, comment or script',
  );
}

function containsSafeHtml(value: HtmlValue): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSafeHtml);
  }
  return isSafeHtml(value);
}

/**
 * Checks one interpolation against the scan state, then advances the state
 * past it. Escaped text never contains `<`, `>` or quotes, so it leaves the
 * state alone; a SafeHtml fragment ends in text (requireTextEnd), so in text
 * it does too.
 */
function admit(st: Scan, value: HtmlValue, after: string): void {
  switch (st.mode) {
    case 'text':
      return;
    case 'quoted':
      if (isUrlAttr(st.attr)) {
        if (!st.empty || !after.startsWith(st.quote) || !isSafeUrl(value)) {
          throw new UnsafeUrlError(st.attr);
        }
      } else if (containsSafeHtml(value)) {
        // Markup inside an attribute value is never what was meant.
        throw new UnsafeAttributeError(`markup into ${st.attr}`);
      }
      st.empty = false;
      return;
    case 'beforeValue':
    case 'unquoted':
      if (isUrlAttr(st.attr)) {
        throw new UnsafeUrlError(st.attr);
      }
      throw new UnsafeAttributeError(`into unquoted ${st.attr}`);
    case 'raw':
      if (st.rcdata) {
        // Escaped text is fine in a textarea or title; markup is not.
        if (containsSafeHtml(value)) {
          throw new UnsafeAttributeError(`markup into <${st.tag}>`);
        }
        st.match = 0;
        return;
      }
      // Script and style bodies take only a constant written in this
      // codebase, and only one that cannot close the element.
      if (isSafeHtml(value) && mintedStatic.has(value)) {
        const before = st.mode;
        feed(st, value.value);
        if (st.mode === before && st.match === 0) {
          return;
        }
      }
      throw new UnsafeAttributeError(`into <${st.tag}>`);
    default:
      throw new UnsafeAttributeError('in a tag, attribute name or comment');
  }
}

/** Template strings arrays already checked; a call site reuses its array. */
const templates = new WeakSet<object>();

/**
 * True only for a strings array shaped like the one the engine passes to a
 * tag: a frozen array whose own `raw` is non-enumerable, non-writable,
 * non-configurable and a frozen array of strings of the same length.
 * Object.assign([evil], { raw }) fails (raw is enumerable), with or without
 * Object.freeze.
 *
 * Known limit: a forgery built with Object.defineProperty(arr, 'raw',
 * { value: Object.freeze([...]) }) and then Object.freeze(arr) has exactly
 * this shape and passes; no runtime check can tell it from the engine's
 * array. Only lint stops it: the no-restricted-syntax rules allow html and
 * staticHtml solely as a tagged template's tag (plus their own declaration
 * and un-aliased import/export specifiers), so no forged array can reach
 * them from code that passes `yarn lint`.
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

function requireTemplate(
  strings: unknown,
  tag: string,
): asserts strings is TemplateStringsArray {
  if (!isTemplateStrings(strings)) {
    throw new TypeError(`${tag} must be used as a tagged template`);
  }
  // A tagged template with an invalid escape (`\\u{` …) has an undefined
  // cooked string.
  if (strings.some((part) => part === undefined)) {
    throw new UnsafeAttributeError(
      `${tag} templates with an invalid escape sequence`,
    );
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
  // One forward scan over the literals, carried across the values: linear
  // in the template, and a `<` inside a value can never restart it.
  const st = newScan();
  let out = strings[0];
  feed(st, strings[0]);
  values.forEach((value, i) => {
    const after = strings[i + 1];
    admit(st, value, after);
    out += render(value) + after;
    feed(st, after);
  });
  requireTextEnd(st);
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
  const st = newScan();
  feed(st, strings[0]);
  requireTextEnd(st);
  return mintHtml(strings[0], true);
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

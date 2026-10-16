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
/** Raw-text constants (staticRaw): the only thing a script or style body may take, and never markup. */
const mintedRaw = new WeakSet<object>();
/**
 * Markup that must not go inside <svg>: it holds a script, style or
 * textarea, or a title with markup in it. Those parse as markup in foreign
 * content, not as the text they were checked as.
 */
const notForeignSafe = new WeakSet<object>();

function mintHtml(
  value: string,
  flags: { raw?: boolean; foreignUnsafe?: boolean } = {},
): SafeHtml {
  const out = Object.freeze({
    value,
    toString: () => value,
  }) as unknown as SafeHtml;
  mintedHtml.add(out);
  if (flags.raw) {
    mintedRaw.add(out);
  }
  if (flags.foreignUnsafe) {
    notForeignSafe.add(out);
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
 * Attributes that may take an escaped string or number. Anything else (on*,
 * style, srcdoc, content, http-equiv, SVG animation targets, …) takes no
 * data at all: escaping is not enough where the value is code or a URL.
 * URL attributes are separate and take only a SafeUrl. Names compare in
 * lower case, so SVG's viewBox is `viewbox`.
 */
// Not here, on purpose: id and name (member data in them clobbers DOM
// globals and could retarget the copy button's getElementById), type (it
// changes what script, object and embed load) and method. Nothing
// interpolates them: they are always literals.
const DATA_ATTRS = new Set([
  'class',
  'title',
  'alt',
  'value',
  'width',
  'height',
  'viewbox',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'transform',
  'fill',
  'stroke',
  'stroke-width',
  'role',
  'for',
  'colspan',
  'rowspan',
  'datetime',
  'min',
  'max',
  'step',
  'placeholder',
  'readonly',
  'disabled',
  'selected',
  'checked',
  'autocomplete',
  'maxlength',
  'size',
  'rows',
  'cols',
  'lang',
  'dir',
  'nonce',
]);

/** aria-* and data-*, but never `data` itself (a URL attribute). */
const isDataAttr = (name: string) => {
  const lower = name.toLowerCase();
  return (
    DATA_ATTRS.has(lower) ||
    /^aria-[a-z]+$/.test(lower) ||
    /^data-[a-z0-9-]+$/.test(lower)
  );
};

/** Raw text: no data inside, except a staticRaw constant. */
const RAW_TEXT = new Set(['script', 'style']);
/** RCDATA: escaped text only. */
const RCDATA = new Set(['textarea', 'title']);
/** Elements the subset does not model: refused outright. */
const UNSUPPORTED_TAGS = new Set([
  'plaintext',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'math',
  // A base href retargets every relative link; a meta can refresh,
  // redirect or set a CSP. The page shell's own <meta> lines are allowed
  // only in a template that starts with the doctype (see tagNamed).
  'base',
  'meta',
]);

/** The old "in select" parser state drops these tags' meaning; refuse them there. */
const NOT_IN_SELECT = new Set(['style', 'script', 'title', 'textarea']);

/*
 * Accepted residuals (reviewed):
 * - fill / stroke take an escaped string, so `url(#id)` is possible; SVG
 *   paint references are same-document only and fetch nothing.
 * - Names are lower-cased with toLowerCase, which also folds some
 *   non-ASCII letters (the Kelvin sign K becomes k). Browsers fold ASCII
 *   only, so a folded name here is either refused (stricter) or matches an
 *   allow-listed name the browser treats as an unknown, inert attribute.
 * - object, embed, link and form are allowed only as literals; their URL
 *   attributes (data, src, href, action) still take only a SafeUrl, and
 *   type is never interpolated.
 */
/** Inside <svg>, only these: no style, script, foreignObject, or HTML that breaks out. */
const SVG_TAGS = new Set([
  'svg',
  'g',
  'rect',
  'line',
  'polyline',
  'polygon',
  'path',
  'circle',
  'ellipse',
  'text',
  'tspan',
  'title',
  'desc',
  'defs',
  'use',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'symbol',
  'marker',
  'mask',
  'pattern',
]);

type Mode =
  | 'text'
  | 'tagOpen' // just after `<`
  | 'endTagOpen' // just after `</`
  | 'tagName'
  | 'markup' // after `<!`: a comment or the doctype
  | 'comment'
  | 'doctype'
  | 'beforeAttr'
  | 'attrName'
  | 'afterAttrName'
  | 'beforeValue'
  | 'quoted'
  | 'unquoted'
  | 'afterQuoted'
  | 'raw'; // script/style raw text or textarea/title RCDATA, until `</tag`

/**
 * The tokenizer's state for a deliberately small subset of HTML, carried
 * forward from the start of a template across its literals and values.
 * Anything outside the subset throws (fail closed): the subset is what
 * these pages use, not what browsers accept.
 */
interface Scan {
  mode: Mode;
  /** Characters fed so far, plus one per value: the doctype must be first. */
  offset: number;
  tagStart: number;
  tag: string;
  endTag: boolean;
  selfClosing: boolean;
  attr: string;
  quote: string;
  /** Nothing has been written into the quoted value yet. */
  empty: boolean;
  /** Raw text: how much of `</tag` has been matched; RCDATA vs raw text. */
  match: number;
  rcdata: boolean;
  rawTail: string;
  /** Comment: consecutive `-` just seen, and body length. */
  dashes: number;
  commentLen: number;
  /** After `<!`. */
  seen: string;
  /** Open <svg> elements, and whether we are in an SVG <title>. */
  foreign: number;
  foreignTitle: boolean;
  /** This markup must not go inside <svg> (see notForeignSafe). */
  foreignUnsafe: boolean;
  /** The template began with the doctype: the page shell, where <meta> is allowed. */
  shell: boolean;
  /** Inside a <select>. */
  inSelect: boolean;
}

const newScan = (): Scan => ({
  mode: 'text',
  offset: 0,
  tagStart: 0,
  tag: '',
  endTag: false,
  selfClosing: false,
  attr: '',
  quote: '',
  empty: true,
  match: 0,
  rcdata: false,
  rawTail: '',
  dashes: 0,
  commentLen: 0,
  seen: '',
  foreign: 0,
  foreignTitle: false,
  foreignUnsafe: false,
  shell: false,
  inSelect: false,
});

const isSpace = (ch: string) =>
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
const isLetter = (ch: string) => /[A-Za-z]/.test(ch);
const isTagChar = (ch: string) => /[A-Za-z0-9-]/.test(ch);

function unsupported(what: string): never {
  throw new UnsafeAttributeError(`unsupported markup: ${what}`);
}

/** The tag name is complete: check it against the subset. */
function tagNamed(st: Scan): void {
  if (st.endTag) {
    if (st.foreignTitle && st.tag !== 'title') {
      unsupported(`</${st.tag}> inside an SVG title`);
    }
    return;
  }
  if (UNSUPPORTED_TAGS.has(st.tag) && !(st.tag === 'meta' && st.shell)) {
    unsupported(`<${st.tag}>`);
  }
  if (st.inSelect && NOT_IN_SELECT.has(st.tag)) {
    unsupported(`<${st.tag}> inside <select>`);
  }
  if (st.foreign > 0 && !SVG_TAGS.has(st.tag)) {
    unsupported(`<${st.tag}> inside <svg>`);
  }
}

/** The `>` that ends a tag. */
function closeTag(st: Scan): void {
  const { tag } = st;
  st.mode = 'text';
  if (tag === 'select') {
    st.inSelect = !st.endTag && !st.selfClosing;
  }
  if (st.endTag) {
    if (tag === 'svg' && st.foreign > 0) {
      st.foreign -= 1;
    } else if (tag === 'title' && st.foreignTitle) {
      st.foreignTitle = false;
    }
  } else if (st.foreign > 0) {
    // SVG: title holds text only (checked in step); nested svg nests.
    if (!st.selfClosing && tag === 'svg') {
      st.foreign += 1;
    } else if (!st.selfClosing && tag === 'title') {
      st.foreignTitle = true;
    }
  } else if (tag === 'svg' && !st.selfClosing) {
    st.foreign = 1;
  } else if (RAW_TEXT.has(tag) || RCDATA.has(tag)) {
    st.mode = 'raw';
    st.rcdata = RCDATA.has(tag);
    st.match = 0;
    st.rawTail = '';
    if (tag !== 'title') {
      st.foreignUnsafe = true;
    }
  }
  st.selfClosing = false;
}

function startAttr(st: Scan, ch: string): void {
  if (ch === '"' || ch === "'" || ch === '<' || ch === '=' || ch === '`') {
    unsupported(`${ch} where an attribute name should be`);
  }
  st.mode = 'attrName';
  st.attr = ch;
  st.selfClosing = false;
}

function stepRaw(st: Scan, ch: string): void {
  const target = `</${st.tag}`;
  if (!st.rcdata) {
    st.rawTail = (st.rawTail + ch).slice(-4);
    if (st.rawTail === '<!--') {
      unsupported(`<!-- inside <${st.tag}>`);
    }
  }
  if (st.match === target.length) {
    // `</tag` seen: it ends the element only if the name ends here.
    if (isSpace(ch) || ch === '/') {
      st.mode = 'beforeAttr';
      st.endTag = true;
      return;
    }
    if (ch === '>') {
      st.mode = 'text';
      st.endTag = true;
      return;
    }
    st.match = 0;
  }
  if (ch.toLowerCase() === target[st.match]) {
    st.match += 1;
    return;
  }
  if (st.match > 0 && st.tag === 'title') {
    // A `<` in a title that is not its end tag: markup once inside <svg>.
    st.foreignUnsafe = true;
  }
  st.match = ch === '<' ? 1 : 0;
}

/**
 * One character of the subset tokenizer (shaped after WHATWG 13.2.5).
 * Forward only, so a `<`, `>` or comment opener inside a quoted value is
 * just part of the value.
 */
function step(st: Scan, ch: string): void {
  st.offset += 1;
  switch (st.mode) {
    case 'text':
      if (ch === '<') {
        st.mode = 'tagOpen';
        st.tagStart = st.offset - 1;
      }
      return;
    case 'tagOpen':
      if (ch === '/') {
        st.mode = 'endTagOpen';
      } else if (st.foreignTitle) {
        unsupported('markup inside an SVG title');
      } else if (isLetter(ch)) {
        st.mode = 'tagName';
        st.tag = ch.toLowerCase();
        st.endTag = false;
      } else if (ch === '!') {
        st.mode = 'markup';
        st.seen = '';
      } else {
        unsupported(`"<${ch}" (write &lt; for a literal <)`);
      }
      return;
    case 'endTagOpen':
      if (!isLetter(ch)) {
        unsupported(`"</${ch}"`);
      }
      st.mode = 'tagName';
      st.tag = ch.toLowerCase();
      st.endTag = true;
      return;
    case 'tagName':
      if (isTagChar(ch)) {
        st.tag += ch.toLowerCase();
        return;
      }
      tagNamed(st);
      if (isSpace(ch)) {
        st.mode = 'beforeAttr';
      } else if (ch === '/') {
        st.mode = 'beforeAttr';
        st.selfClosing = true;
      } else if (ch === '>') {
        closeTag(st);
      } else {
        unsupported(`"${ch}" in a tag name`);
      }
      return;
    case 'markup': {
      st.seen += ch;
      const lower = st.seen.toLowerCase();
      if (st.seen === '--') {
        st.mode = 'comment';
        st.dashes = 0;
        st.commentLen = 0;
      } else if (lower === 'doctype') {
        if (st.tagStart !== 0) {
          unsupported('a doctype anywhere but the start of the page');
        }
        st.mode = 'doctype';
        st.shell = true;
      } else if (!'--'.startsWith(st.seen) && !'doctype'.startsWith(lower)) {
        unsupported(`"<!${st.seen}"`);
      }
      return;
    }
    case 'comment':
      // Only `<!-- text -->` with no `--` inside: browsers also close a
      // comment at `--!>`, `<!-->` and `<!--->`, which this subset refuses.
      if (ch === '-') {
        st.dashes += 1;
        st.commentLen += 1;
        if (st.dashes > 2) {
          unsupported('"---" in a comment');
        }
      } else if (ch === '>' && st.dashes === 2) {
        st.mode = 'text';
      } else if (ch === '>' && st.commentLen === st.dashes) {
        unsupported('an abruptly closed comment (<!--> or <!--->)');
      } else if (st.dashes === 2) {
        unsupported('"--" inside a comment');
      } else {
        st.dashes = 0;
        st.commentLen += 1;
      }
      return;
    case 'doctype':
      if (ch === '>') {
        st.mode = 'text';
      } else if (ch === '<' || ch === '"' || ch === "'") {
        unsupported('a doctype with an identifier');
      }
      return;
    case 'beforeAttr':
      if (ch === '>') {
        closeTag(st);
      } else if (ch === '/') {
        st.selfClosing = true;
      } else if (isSpace(ch)) {
        // Self-closing only when `/` is directly followed by `>`: `<svg / >`
        // opens an svg, as browsers parse it.
        st.selfClosing = false;
      } else {
        startAttr(st, ch);
      }
      return;
    case 'attrName':
      if (isSpace(ch)) {
        st.mode = 'afterAttrName';
      } else if (ch === '/') {
        st.mode = 'beforeAttr';
        st.selfClosing = true;
      } else if (ch === '=') {
        st.mode = 'beforeValue';
      } else if (ch === '>') {
        closeTag(st);
      } else if (ch === '"' || ch === "'" || ch === '<') {
        unsupported(`${ch} in an attribute name`);
      } else {
        st.attr += ch;
      }
      return;
    case 'afterAttrName':
      if (ch === '/') {
        st.mode = 'beforeAttr';
        st.selfClosing = true;
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
        unsupported('an attribute with = and no value');
      } else if (!isSpace(ch)) {
        st.mode = 'unquoted';
        if (ch === '<' || ch === '=' || ch === '`') {
          unsupported(`${ch} in an unquoted value`);
        }
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
      } else if ('"\'<=`'.includes(ch)) {
        unsupported(`${ch} in an unquoted value`);
      }
      return;
    case 'afterQuoted':
      if (isSpace(ch)) {
        st.mode = 'beforeAttr';
      } else if (ch === '/') {
        st.mode = 'beforeAttr';
        st.selfClosing = true;
      } else if (ch === '>') {
        closeTag(st);
      } else {
        unsupported('attributes with no space between them');
      }
      return;
    case 'raw':
      stepRaw(st, ch);
      return;
    default:
      return;
  }
}

function feed(st: Scan, text: string): void {
  for (const ch of text) {
    step(st, ch);
  }
}

/** A minted fragment must end where it began: in text, outside any tag, comment, raw text or <svg>. */
function requireTextEnd(st: Scan): void {
  if (st.mode === 'text' && st.foreign === 0 && !st.foreignTitle) {
    return;
  }
  if (st.mode === 'quoted' && isUrlAttr(st.attr)) {
    throw new UnsafeUrlError(st.attr);
  }
  throw new UnsafeAttributeError(
    'here: a fragment must end outside any tag, comment, raw text or <svg>',
  );
}

function containsSafeHtml(value: HtmlValue): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSafeHtml);
  }
  return isSafeHtml(value);
}

/** Every SafeHtml in a text-position value: markup (not raw text), and fit for <svg> when inside one. */
function admitText(st: Scan, value: HtmlValue): void {
  if (Array.isArray(value)) {
    value.forEach((part) => admitText(st, part));
    return;
  }
  if (!isSafeHtml(value)) {
    return;
  }
  if (mintedRaw.has(value)) {
    throw new UnsafeAttributeError('a raw-text constant (staticRaw) as markup');
  }
  if (st.foreignTitle) {
    throw new UnsafeAttributeError('markup into an SVG title');
  }
  const unsafeInSvg = notForeignSafe.has(value);
  if (st.foreign > 0 && unsafeInSvg) {
    throw new UnsafeAttributeError(
      'markup with a script, style, textarea or marked-up title into <svg>',
    );
  }
  if (unsafeInSvg) {
    st.foreignUnsafe = true;
  }
}

/**
 * Checks one interpolation against the scan state. Escaped text never
 * contains `<`, `>` or quotes, and every SafeHtml ends in text, so neither
 * moves the state; the value is not scanned again.
 */
function admit(st: Scan, value: HtmlValue, after: string): void {
  st.offset += 1;
  switch (st.mode) {
    case 'text':
      admitText(st, value);
      return;
    case 'quoted':
      if (isUrlAttr(st.attr)) {
        if (!st.empty || !after.startsWith(st.quote) || !isSafeUrl(value)) {
          throw new UnsafeUrlError(st.attr);
        }
      } else if (!isDataAttr(st.attr)) {
        throw new UnsafeAttributeError(
          `into ${st.attr}: it is not an attribute that takes data`,
        );
      } else if (containsSafeHtml(value)) {
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
      // A pending `</tag` could be completed by the value: escaped text
      // has no `<`, so with nothing pending it cannot start one.
      if (st.match > 0) {
        throw new UnsafeAttributeError(`into a pending </${st.tag}`);
      }
      if (st.rcdata) {
        if (containsSafeHtml(value)) {
          throw new UnsafeAttributeError(`markup into <${st.tag}>`);
        }
        return;
      }
      // Script and style bodies take one raw-text constant (staticRaw),
      // which was checked at mint to hold no `</` or `<!--`.
      if (isSafeHtml(value) && mintedRaw.has(value)) {
        return;
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
 * Markup from a supported subset of HTML only; anything else throws
 * (UnsafeAttributeError), so what this cannot model it refuses.
 * - Literals: text, `<!-- comments -->` with no `--` inside, start and end
 *   tags, and a doctype only at the very start. No `<?`, other `<!`,
 *   CDATA, `</` + non-letter, a bare `<`, or the unsupported elements.
 *   Inside <svg>: SVG drawing elements only, and text-only <title>.
 * - Values:
 *   - text: escaped strings, or SafeHtml markup (not staticRaw; inside
 *     <svg>, none holding script, style, textarea or a marked-up title);
 *   - URL attributes: exactly one SafeUrl filling the whole quoted value
 *     (UnsafeUrlError otherwise);
 *   - other quoted attributes: an escaped string or number, and only for
 *     the DATA_ATTRS allow-list (aria-*, data-* too); never SafeHtml;
 *   - textarea/title: escaped text, and not while `</tag` is half-written;
 *   - script/style: one staticRaw constant, nothing else;
 *   - anywhere else (names, unquoted values, comments): nothing.
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
  return mintHtml(out, { foreignUnsafe: st.foreignUnsafe });
}

function onlyLiteral(strings: TemplateStringsArray, tag: string): string {
  requireTemplate(strings, tag);
  // One entry means nothing was interpolated.
  if (strings.length !== 1) {
    throw new TypeError(
      `${tag} takes a template literal without interpolation`,
    );
  }
  return strings[0];
}

/** Constant markup written in this codebase, with no interpolation at all. */
export function staticHtml(strings: TemplateStringsArray): SafeHtml {
  const text = onlyLiteral(strings, 'staticHtml');
  const st = newScan();
  feed(st, text);
  requireTextEnd(st);
  return mintHtml(text, { foreignUnsafe: st.foreignUnsafe });
}

/**
 * A constant script or style body (the CSS, the copy script). Checked as raw
 * text, not markup: it may hold `<` (as in `a<b`), but no `</`, no `<!--`
 * and no trailing `<`, so it can never end or escape its element. It is
 * accepted only inside <script> or <style>, never as markup.
 */
export function staticRaw(strings: TemplateStringsArray): SafeHtml {
  const text = onlyLiteral(strings, 'staticRaw');
  if (text.includes('</') || text.includes('<!--') || text.endsWith('<')) {
    throw new UnsafeAttributeError(
      'staticRaw text that could end its element (</, <!-- or a trailing <)',
    );
  }
  return mintHtml(text, { raw: true, foreignUnsafe: true });
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

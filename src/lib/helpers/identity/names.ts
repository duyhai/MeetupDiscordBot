import {
  IdentityField,
  IdentityPlatform,
} from '../../repositories/identityTypes.js';

/**
 * Display names for change subjects, keyed by identityNameKey.
 *
 * Read from the stored baselines, never from a live API: the digest already
 * makes two full roster passes, and the names those passes saw are sitting in
 * the baseline tables.
 */
export type IdentityNames = Map<string, string>;

export interface IdentitySubject {
  platform: IdentityPlatform;
  scopeId: string;
  subjectId: string;
}

// Platform and scope are part of the key because a subject id is only unique
// within them: a Meetup member id and a Discord user id are both bare digits.
export function identityNameKey(
  platform: IdentityPlatform,
  scopeId: string,
  subjectId: string,
): string {
  return `${platform}:${scopeId}:${subjectId}`;
}

export function displayNameFor(
  subject: IdentitySubject,
  names: IdentityNames,
): string | undefined {
  const name = names.get(
    identityNameKey(subject.platform, subject.scopeId, subject.subjectId),
  );
  return name && sanitizeDisplayText(name) ? name : undefined;
}

/**
 * The name to show for a Meetup member: the stored baseline's, which after a
 * sweep is their CURRENT name. A name-change row whose baseline is gone (the
 * member was forgotten) still carries the name itself, so use that before
 * giving up and showing an id.
 */
export function meetupDisplayNameFor(
  change: IdentitySubject & {
    field: IdentityField;
    oldValue: string | null;
    newValue: string | null;
  },
  names: IdentityNames,
): string | undefined {
  const stored = displayNameFor(change, names);
  if (stored) {
    return stored;
  }
  if (change.field !== 'name') {
    return undefined;
  }
  return (
    [change.newValue, change.oldValue].find(
      (value) => value && sanitizeDisplayText(value),
    ) ?? undefined
  );
}

/**
 * The name an organizer would recognise the member by in the guild: server
 * nickname first, then the account's display name, then the username.
 */
export function discordDisplayName(snapshot: {
  nickname: string | null;
  globalName: string | null;
  username: string | null;
}): string | null {
  return (
    [snapshot.nickname, snapshot.globalName, snapshot.username].find(
      (value) => value && sanitizeDisplayText(value),
    ) ?? null
  );
}

/**
 * Undefined for anything that is not a bare numeric id. Real Meetup member
 * ids always are; refusing the rest means the id can be dropped into a
 * markdown link target or an href without it being able to close either.
 */
export function meetupProfileUrl(meetupMemberId: string): string | undefined {
  return /^\d+$/.test(meetupMemberId)
    ? `https://www.meetup.com/members/${meetupMemberId}/`
    : undefined;
}

const MAX_DISPLAY_LENGTH = 64;

// Characters that draw nothing: zero-width space and marks, bidi overrides
// and isolates, word joiners, the Hangul fillers, soft hyphen, combining
// grapheme joiner, Mongolian vowel separator, Arabic letter mark. Able to
// fake a blank name, or to reorder or disguise the rest of the row. The two
// joiners (U+200C, U+200D) are deliberately NOT here -- see ORPHAN_JOINER.
const INVISIBLE =
  /[\u00AD\u034F\u061C\u115F\u1160\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\u3164\uFEFF\uFFA0]/g;
// A joiner is kept only where it does its job: between letters (Persian and
// Indic scripts need the non-joiner) or between emoji (family and flag
// sequences need the joiner). Anywhere else -- leading, trailing, beside a
// space, doubled, or all on its own -- it is just another invisible.
const ORPHAN_JOINER =
  /(?<![\p{L}\p{M}\p{Extended_Pictographic}\uFE0F\u{1F3FB}-\u{1F3FF}])[\u200C\u200D]|[\u200C\u200D](?![\p{L}\p{Extended_Pictographic}])/gu;
const JOINER = /[\u200C\u200D]/g;
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001F\u007F]+/g;
// Everything Discord's markdown gives meaning to mid-line: emphasis, code,
// spoilers, link text and targets, mentions (<@id>, <@&role>, @everyone),
// channel links, custom emoji and bare urls (via the colon).
const MARKDOWN = /[\\*_~`|[\]()<>#:@]/g;

/**
 * The one definition of what a name or value "is" once the characters that
 * draw nothing are gone. Every picker decides blankness on this, so a name
 * made only of invisible characters falls back to the id instead of
 * rendering as an empty link or an empty pair of brackets.
 */
export function sanitizeDisplayText(text: string): string {
  return text
    .replace(INVISIBLE, '')
    .replace(ORPHAN_JOINER, '')
    .replace(WHITESPACE_OR_CONTROL, ' ')
    .trim();
}

/**
 * What a reader actually sees: sanitizeDisplayText with the surviving
 * joiners removed too. A joiner between two Latin letters is kept for
 * display but draws nothing, so comparing sanitised text alone would call
 * "Bob" and "Bo<ZWJ>b" different while showing them identically.
 */
export function visibleSkeleton(text: string): string {
  return sanitizeDisplayText(text).replace(JOINER, '');
}

function truncate(text: string, maxLength: number): string {
  const points = Array.from(text);
  return points.length > maxLength
    ? `${points.slice(0, maxLength).join('')}…`
    : text;
}

/**
 * Makes attacker-controlled text (a Meetup or Discord name) safe to place in
 * an embed line, including inside masked-link text.
 *
 * Truncates BEFORE escaping, and by code point: cutting an escaped string
 * could leave a trailing backslash that swallows the caller's own closing
 * bracket, and cutting by UTF-16 unit could split an emoji.
 */
export function escapeDiscordText(
  text: string,
  maxLength: number = MAX_DISPLAY_LENGTH,
): string {
  return truncate(sanitizeDisplayText(text), maxLength).replace(
    MARKDOWN,
    '\\$&',
  );
}

/**
 * escapeDiscordText for the text of a masked link, `[text](url)`.
 *
 * Square brackets become parentheses instead of being escaped: a
 * backslash-escaped bracket inside link text stops Discord matching the link
 * at all, so "Jane [she/her]" would have rendered as raw markup.
 */
export function escapeDiscordLinkText(
  text: string,
  maxLength: number = MAX_DISPLAY_LENGTH,
): string {
  return escapeDiscordText(
    text.replace(/\[/g, '(').replace(/\]/g, ')'),
    maxLength,
  );
}

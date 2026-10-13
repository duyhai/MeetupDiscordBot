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
  return name && name.trim() ? name : undefined;
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
    [change.newValue, change.oldValue].find((value) => value && value.trim()) ??
    undefined
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
      (value) => value && value.trim(),
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

// Bidi overrides/isolates and zero-width characters: invisible, and able to
// reorder or disguise the rest of the row.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001F\u007F]+/g;
// Everything Discord's markdown gives meaning to mid-line: emphasis, code,
// spoilers, link text and targets, mentions (<@id>, <@&role>, @everyone),
// channel links, custom emoji and bare urls (via the colon).
const MARKDOWN = /[\\*_~`|[\]()<>#:@]/g;

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
  const flat = text
    .replace(INVISIBLE, '')
    .replace(WHITESPACE_OR_CONTROL, ' ')
    .trim();
  const points = Array.from(flat);
  const cut =
    points.length > maxLength
      ? `${points.slice(0, maxLength).join('')}…`
      : flat;
  return cut.replace(MARKDOWN, '\\$&');
}

import { Logger } from 'tslog';

import { PUBLIC_APP_ORIGIN } from '../../constants.js';
import type { LogEntry } from '../helpers/discordLogger.js';
import { escapeDiscordText } from '../helpers/identity/names.js';
import { readImageSize, stripImageMetadata } from '../helpers/imageBytes.js';
import { neutralizeMentions } from '../helpers/neutralizeMentions.js';
import { parseUtcDateStrict } from '../helpers/suspensionCsv.js';
import { pacificToday } from '../helpers/suspensionList.js';
import { DASHBOARD_PATHS, dashboardPath } from '../reports/dashboardPaths.js';
import type { PostgresBanRepository } from '../repositories/postgresBanRepository.js';
import { fitFieldValue, postWithoutWaiting } from '../workspace/service.js';
import { BanCsvError, parseBanCsv } from './banCsv.js';
import {
  BAN_LIFT_REASON_MAX,
  BAN_NAME_MAX,
  BAN_NOTES_MAX,
  BAN_PHOTO_MAX_BYTES,
  BAN_PHOTO_MAX_SIDE,
  BanInsert,
  BanRow,
} from './types.js';

const logger = new Logger({ name: 'banService' });

export interface BanServiceDeps {
  now(): Date;
  repository(): Promise<
    Pick<
      PostgresBanRepository,
      'record' | 'importMany' | 'lift' | 'setUploadedPhoto'
    >
  >;
  /** Posts to the moderation log (logModeration: embed only, no pings). */
  moderationLog(entry: LogEntry): Promise<unknown>;
  /** Live Discord check for the 1.5 Leadership Team role. Rejects when Discord cannot answer. */
  isLeadership(discordUserId: string): Promise<boolean>;
}

export type BanResultCode =
  | 'recorded'
  | 'imported'
  | 'lifted'
  | 'photo-saved'
  | 'invalid'
  | 'bad-member-id'
  | 'bad-date'
  | 'name-too-long'
  | 'notes-too-long'
  | 'already-banned'
  | 'not-active'
  | 'reason-required'
  | 'reason-too-long'
  | 'photo-not-accepted'
  | 'photo-too-large'
  | 'photo-too-big'
  | 'not-leadership'
  | 'leadership-unavailable'
  | 'error';

interface Gate {
  /** The signed-in Discord user id. */
  actor: string;
  /**
   * True only when the caller asked Discord live, for this request, that
   * `actor` holds the 1.5 Leadership Team role. Otherwise the service asks
   * deps.isLeadership.
   */
  leadershipConfirmed?: boolean;
}

/** `${PUBLIC_APP_ORIGIN}/dashboard/suspensions?state=banned`. */
export const BANNED_TAB_URL = `${PUBLIC_APP_ORIGIN}${dashboardPath(DASHBOARD_PATHS.suspensions)}?state=banned`;

const DISCORD_ID = /^[0-9]{17,20}$/;
const MEMBER_ID = /^[0-9]{1,20}$/;
const FIRST_BAN_DAY = '2013-03-01';
const MAX_SERIAL = 2 ** 31 - 1;
/** Base64url, no padding: 153600 bytes are at most 204800 characters (D3). */
const PHOTO_FIELD = /^[A-Za-z0-9_-]{1,204800}$/;
/** Code points of notes or a reason in an embed, before escaping. */
const TEXT_LOG_MAX = 900;

const codePoints = (text: string): number => [...text].length;

const isBanId = (id: unknown): id is number =>
  typeof id === 'number' &&
  Number.isSafeInteger(id) &&
  id >= 1 &&
  id <= MAX_SERIAL;

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

/** A form text field: absent is '', a string is trimmed with CRLF as LF, anything else undefined. */
function formText(value: unknown): string | undefined {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return undefined;
  return value.replace(/\r\n/g, '\n').trim();
}

/**
 * The live Leadership check, as performWorkspaceAction: skipped when the
 * caller already asked Discord. A refusal posts nothing (D13).
 */
async function gate(
  deps: BanServiceDeps,
  input: Gate,
): Promise<'not-leadership' | 'leadership-unavailable' | undefined> {
  if (input.leadershipConfirmed === true) {
    return undefined;
  }
  try {
    return (await deps.isLeadership(input.actor)) === true
      ? undefined
      : 'not-leadership';
  } catch (error: unknown) {
    logger.warn(`Ban Leadership check failed: ${errorClass(error)}`);
    return 'leadership-unavailable';
  }
}

const validActor = (input: Gate): boolean =>
  typeof input.actor === 'string' && DISCORD_ID.test(input.actor);

/** Validates an Add-ban form: the insert, or the code to answer. */
function banInsertOf(
  input: Gate & {
    memberId: unknown;
    memberName: unknown;
    bannedOn: unknown;
    notes: unknown;
  },
  today: string,
): { ok: true; insert: BanInsert } | { ok: false; code: BanResultCode } {
  const memberId =
    typeof input.memberId === 'string' ? input.memberId.trim() : '';
  if (!MEMBER_ID.test(memberId)) {
    return { ok: false, code: 'bad-member-id' };
  }
  const memberName = formText(input.memberName);
  const day = formText(input.bannedOn);
  const notes = formText(input.notes);
  if (memberName === undefined || day === undefined || notes === undefined) {
    return { ok: false, code: 'invalid' };
  }
  if (
    day !== '' &&
    (parseUtcDateStrict(day) === undefined ||
      day < FIRST_BAN_DAY ||
      day > today)
  ) {
    return { ok: false, code: 'bad-date' };
  }
  if (codePoints(memberName) > BAN_NAME_MAX) {
    return { ok: false, code: 'name-too-long' };
  }
  if (codePoints(notes) > BAN_NOTES_MAX) {
    return { ok: false, code: 'notes-too-long' };
  }
  return {
    ok: true,
    insert: {
      memberId,
      memberName,
      bannedOn: day === '' ? null : day,
      notes,
      recordedBy: input.actor,
    },
  };
}

/** One staff Add ban. A repository error propagates; the route answers it. */
export async function recordBan(
  deps: BanServiceDeps,
  input: Gate & {
    memberId: unknown;
    memberName: unknown;
    bannedOn: unknown;
    notes: unknown;
  },
): Promise<{ code: BanResultCode }> {
  if (!validActor(input)) {
    return { code: 'invalid' };
  }
  const checked = banInsertOf(input, pacificToday(deps.now()));
  if (checked.ok === false) {
    return { code: checked.code };
  }
  const refused = await gate(deps, input);
  if (refused !== undefined) {
    return { code: refused };
  }
  const outcome = await (await deps.repository()).record(checked.insert);
  if (outcome.ok === false) {
    return { code: 'already-banned' };
  }
  postWithoutWaiting(deps, banEntry('recorded', outcome.ban, input.actor));
  return { code: 'recorded' };
}

/**
 * One CSV import, all rows or none. Parse errors are answered before the
 * gate; a collision with a stored ban is reported on its row.
 */
export async function importBans(
  deps: BanServiceDeps,
  input: Gate & { csv: unknown },
): Promise<
  | { code: 'imported'; count: number }
  | { code: 'import-refused'; errors: BanCsvError[] }
  | { code: BanResultCode }
> {
  if (!validActor(input) || typeof input.csv !== 'string') {
    return { code: 'invalid' };
  }
  const parsed = parseBanCsv(input.csv, pacificToday(deps.now()));
  if (parsed.ok === false) {
    return { code: 'import-refused', errors: parsed.errors };
  }
  const refused = await gate(deps, input);
  if (refused !== undefined) {
    return { code: refused };
  }
  const outcome = await (
    await deps.repository()
  ).importMany(
    parsed.rows.map((row) => ({
      memberId: row.memberId,
      memberName: row.memberName,
      bannedOn: row.bannedOn,
      notes: row.notes,
      recordedBy: input.actor,
    })),
  );
  if (outcome.ok === false) {
    return {
      code: 'import-refused',
      errors: [
        {
          row: parsed.rows[outcome.index]?.rowNumber ?? null,
          code: 'already-banned',
        },
      ],
    };
  }
  postWithoutWaiting(deps, banImportEntry(outcome.count, input.actor));
  return { code: 'imported', count: outcome.count };
}

/** Lifts one active ban; the row and its photo stay. */
export async function liftBan(
  deps: BanServiceDeps,
  input: Gate & { banId: number; reason: unknown },
): Promise<{ code: BanResultCode }> {
  if (!validActor(input) || !isBanId(input.banId)) {
    return { code: 'invalid' };
  }
  const reason = formText(input.reason);
  if (reason === undefined) {
    return { code: 'invalid' };
  }
  if (reason === '') {
    return { code: 'reason-required' };
  }
  if (codePoints(reason) > BAN_LIFT_REASON_MAX) {
    return { code: 'reason-too-long' };
  }
  const refused = await gate(deps, input);
  if (refused !== undefined) {
    return { code: refused };
  }
  const lifted = await (
    await deps.repository()
  ).lift(input.banId, input.actor, reason);
  if (lifted === undefined) {
    return { code: 'not-active' };
  }
  postWithoutWaiting(deps, banEntry('lifted', lifted, input.actor));
  return { code: 'lifted' };
}

/** A staff photo for one active ban: decoded, checked and stripped before the gate. */
export async function uploadBanPhoto(
  deps: BanServiceDeps,
  input: Gate & { banId: number; photo: unknown },
): Promise<{ code: BanResultCode }> {
  if (!validActor(input) || !isBanId(input.banId)) {
    return { code: 'invalid' };
  }
  const bytes = decodePhotoField(input.photo);
  if (bytes === undefined) {
    return { code: 'photo-not-accepted' };
  }
  const checked = checkBanPhoto(bytes);
  if (checked.ok === false) {
    return { code: checked.code };
  }
  const refused = await gate(deps, input);
  if (refused !== undefined) {
    return { code: refused };
  }
  const saved = await (
    await deps.repository()
  ).setUploadedPhoto(input.banId, checked.bytes, input.actor);
  if (saved === undefined) {
    return { code: 'not-active' };
  }
  postWithoutWaiting(
    deps,
    banEntry(
      saved.replaced ? 'photo-replaced' : 'photo-uploaded',
      saved.ban,
      input.actor,
    ),
  );
  return { code: 'photo-saved' };
}

/**
 * The photo form field (D3): base64url with no padding, at most 204800
 * characters, and canonical (re-encoding gives the same text), else
 * undefined.
 */
export function decodePhotoField(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !PHOTO_FIELD.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length > 0 && bytes.toString('base64url') === value
    ? bytes
    : undefined;
}

/**
 * The server's photo check: only a WebP or JPEG whose header size can be
 * read, with its metadata stripped (D14); the caps apply to the stripped
 * bytes, which are what gets stored.
 */
export function checkBanPhoto(bytes: Buffer):
  | { ok: true; type: 'image/webp' | 'image/jpeg'; bytes: Buffer }
  | {
      ok: false;
      code: 'photo-not-accepted' | 'photo-too-large' | 'photo-too-big';
    } {
  const stripped = stripImageMetadata(bytes);
  const size = stripped === undefined ? undefined : readImageSize(stripped);
  if (stripped === undefined || size === undefined) {
    return { ok: false, code: 'photo-not-accepted' };
  }
  if (stripped.length > BAN_PHOTO_MAX_BYTES) {
    return { ok: false, code: 'photo-too-large' };
  }
  if (size.width > BAN_PHOTO_MAX_SIDE || size.height > BAN_PHOTO_MAX_SIDE) {
    return { ok: false, code: 'photo-too-big' };
  }
  return { ok: true, type: size.type, bytes: stripped };
}

/** Member-supplied text for an embed: markdown escaped, then every @, <# and </ defused. */
function embedText(text: string, maxLength?: number): string {
  return neutralizeMentions(escapeDiscordText(text, maxLength));
}

const ENTRY_TITLES = {
  recorded: 'Ban recorded',
  lifted: 'Ban lifted',
  'photo-uploaded': 'Ban photo uploaded',
  'photo-replaced': 'Ban photo replaced',
} as const;

const ENTRY_VERBS = {
  recorded: 'recorded a ban.',
  lifted: 'lifted a ban.',
  'photo-uploaded': 'uploaded a ban photo.',
  'photo-replaced': 'replaced a ban photo.',
} as const;

function actorMention(actor: string): string {
  return DISCORD_ID.test(actor) ? `<@${actor}>` : 'A staff member';
}

/**
 * The moderation-log embed for one ban change. No content (`<@id>` in an
 * embed never pings) and never the photo.
 */
export function banEntry(
  kind: 'recorded' | 'lifted' | 'photo-uploaded' | 'photo-replaced',
  ban: BanRow,
  actor: string,
): LogEntry {
  const memberId = MEMBER_ID.test(ban.memberId) ? ban.memberId : 'unknown id';
  const fields: NonNullable<LogEntry['fields']> = [
    {
      name: 'Member',
      value: fitFieldValue(
        `${embedText(ban.memberName || 'Unknown member')} (${memberId})`,
      ),
    },
    { name: 'Banned', value: ban.bannedOn ?? 'Date unknown' },
  ];
  if (kind === 'recorded' && ban.notes) {
    fields.push({
      name: 'Notes',
      value: fitFieldValue(embedText(ban.notes, TEXT_LOG_MAX)),
    });
  }
  if (kind === 'lifted' && ban.liftReason) {
    fields.push({
      name: 'Reason',
      value: fitFieldValue(embedText(ban.liftReason, TEXT_LOG_MAX)),
    });
  }
  return {
    title: ENTRY_TITLES[kind],
    description: `${actorMention(actor)} ${ENTRY_VERBS[kind]}\n${BANNED_TAB_URL}`,
    fields,
  };
}

/** The import embed: the count, the actor and the link; no names or ids (D10). */
export function banImportEntry(count: number, actor: string): LogEntry {
  return {
    title: 'Bans imported',
    description: `${actorMention(actor)} imported bans.\n${BANNED_TAB_URL}`,
    fields: [{ name: 'Count', value: String(count) }],
  };
}

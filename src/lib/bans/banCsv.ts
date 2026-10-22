/**
 * Strict parser for the dashboard's "Import bans" CSV. The same reading
 * rules as the suspension import (readCsvRecords). Errors are a fixed code
 * and a row number only: nothing from the file is ever echoed back.
 */
import {
  parseUtcDateStrict,
  readCsvRecords,
} from '../helpers/suspensionCsv.js';
import { BAN_IMPORT_MAX_ROWS, BAN_NAME_MAX, BAN_NOTES_MAX } from './types.js';

export const BAN_CSV_HEADER = 'member_id,member_name,banned_on,notes';

export type BanCsvErrorCode =
  | 'unreadable'
  | 'unreadable-row'
  | 'header'
  | 'no-rows'
  | 'too-many-rows'
  | 'member-id'
  | 'name-too-long'
  | 'date'
  | 'date-out-of-range'
  | 'notes-too-long'
  | 'duplicate-member'
  | 'already-banned';

export const BAN_CSV_ERROR_TEXT: Readonly<Record<BanCsvErrorCode, string>> = {
  unreadable:
    'The CSV could not be read. Check for a quote that is opened and never closed.',
  'unreadable-row':
    'This row has a character that cannot be stored (a NUL byte). Remove it and import again.',
  header: `The first line must be exactly: ${BAN_CSV_HEADER}`,
  'no-rows': 'The CSV has a header but no bans.',
  'too-many-rows': `One import takes at most ${BAN_IMPORT_MAX_ROWS} bans. Split the file.`,
  'member-id': 'member_id must be the Meetup member number, digits only.',
  'name-too-long': `member_name must be at most ${BAN_NAME_MAX} characters.`,
  date: 'banned_on must be blank or a real date written as YYYY-MM-DD.',
  'date-out-of-range':
    'banned_on must be between 2013-03-01 and today (Pacific).',
  'notes-too-long': `notes must be at most ${BAN_NOTES_MAX} characters.`,
  'duplicate-member': 'This member is already listed on an earlier row.',
  'already-banned': 'This member already has an active ban.',
};

export interface BanCsvError {
  /** The line the row starts on (the header is 1); null for a whole-file error. */
  row: number | null;
  code: BanCsvErrorCode;
}

export interface ParsedBanRow {
  rowNumber: number;
  memberId: string;
  memberName: string;
  bannedOn: string | null;
  notes: string;
}

/** The group's first month: no ban predates it. */
const FIRST_BAN_DAY = '2013-03-01';
const MEMBER_ID = /^[0-9]{1,20}$/;

const codePoints = (text: string): number => [...text].length;

/**
 * All rows, or every error in row order. `today` is the Pacific date
 * ('YYYY-MM-DD'), the latest allowed banned_on.
 */
export function parseBanCsv(
  text: string,
  today: string,
): { ok: true; rows: ParsedBanRow[] } | { ok: false; errors: BanCsvError[] } {
  let records: { record: string[]; rowNumber: number }[];
  try {
    records = readCsvRecords(text);
  } catch {
    return { ok: false, errors: [{ row: null, code: 'unreadable' }] };
  }
  const header = (records[0]?.record ?? [])
    .map((field) => field.trim().toLowerCase())
    .join(',');
  if (header !== BAN_CSV_HEADER) {
    return { ok: false, errors: [{ row: 1, code: 'header' }] };
  }
  const data = records.slice(1);
  if (data.length === 0) {
    return { ok: false, errors: [{ row: null, code: 'no-rows' }] };
  }
  if (data.length > BAN_IMPORT_MAX_ROWS) {
    return { ok: false, errors: [{ row: null, code: 'too-many-rows' }] };
  }

  const errors: BanCsvError[] = [];
  const rows: ParsedBanRow[] = [];
  const seen = new Set<string>();
  for (const { record, rowNumber } of data) {
    const field = (index: number) => (record[index] ?? '').trim();
    const fail = (code: BanCsvErrorCode) =>
      errors.push({ row: rowNumber, code });

    // Postgres text cannot hold NUL: one fixed error, no other checks.
    if (record.some((value) => value.includes('\u0000'))) {
      fail('unreadable-row');
      continue;
    }

    const memberId = field(0);
    const memberName = field(1);
    const day = field(2);
    // Untrimmed join, so an unquoted "late, again" keeps its space.
    const notes = record.slice(3).join(',').replace(/\r\n/g, '\n').trim();

    const idOk = MEMBER_ID.test(memberId);
    if (!idOk) fail('member-id');
    if (codePoints(memberName) > BAN_NAME_MAX) fail('name-too-long');
    let bannedOn: string | null = null;
    if (day !== '') {
      if (parseUtcDateStrict(day) === undefined) {
        fail('date');
      } else if (day < FIRST_BAN_DAY || day > today) {
        fail('date-out-of-range');
      } else {
        bannedOn = day;
      }
    }
    if (codePoints(notes) > BAN_NOTES_MAX) fail('notes-too-long');
    if (idOk) {
      if (seen.has(memberId)) fail('duplicate-member');
      seen.add(memberId);
    }
    rows.push({ rowNumber, memberId, memberName, bannedOn, notes });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, rows };
}

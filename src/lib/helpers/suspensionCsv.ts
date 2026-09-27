/**
 * Parser for the /meetup_record_suspension CSV attachment. The same format
 * serves the one-time spreadsheet backfill and ongoing exception entries,
 * so errors must name the offending row — moderators fix the sheet, not us.
 */
import { parse } from 'csv-parse/sync';

import { SuspensionInsert } from '../repositories/types.js';

// Both header shapes are accepted: the named variant is what the report's
// suggested-suspensions CSV emits; the legacy one keeps old sheet exports
// importable (names default to null there).
const NAMED_HEADER = 'member_id,member_name,duration_days,suspended_at,notes';
const LEGACY_HEADER = 'member_id,duration_days,suspended_at,notes';
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses a strict YYYY-MM-DD date string as UTC midnight, rejecting
 * calendar-invalid dates (e.g. 2026-02-30, which `Date` would silently roll
 * to 2026-03-02) by reconstructing the string from the parsed date and
 * comparing it back. Returns undefined rather than throwing so callers can
 * shape their own error message.
 */
export function parseUtcDateStrict(dateStr: string): Date | undefined {
  if (!DATE_FORMAT.test(dateStr)) {
    return undefined;
  }
  const date = new Date(`${dateStr}T00:00:00Z`);
  const reconstructed = [
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
  ].join('-');
  if (reconstructed !== dateStr) {
    return undefined;
  }
  return date;
}

const WHOLE_NUMBER = /^\d+$/;

/** A parsed row, with the line it starts on so errors and skips can cite it. */
export type ParsedSuspensionRow = SuspensionInsert & { rowNumber: number };

interface ParsedRecord {
  record: string[];
  info: { lines: number };
}

/**
 * csv-parse reports the line a record *ends* on. A note containing a line
 * break spans several lines, so step back over the breaks inside its fields
 * to reach the line a moderator would look for.
 */
function startingLine({ record, info }: ParsedRecord): number {
  const breaksInside = record.reduce(
    (total, field) => total + (field.match(/\n/g) ?? []).length,
    0,
  );
  return info.lines - breaksInside;
}

export function parseSuspensionCsv(rawText: string): ParsedSuspensionRow[] {
  // A real RFC 4180 parser: quoted fields may contain commas, escaped quotes
  // and line breaks. Splitting on newlines first turned the second line of a
  // multi-line note into a phantom suspension for whichever member it named.
  const parsed = parse(rawText, {
    // Excel "CSV UTF-8" prepends a byte-order mark to the header.
    bom: true,
    skip_empty_lines: true,
    // A blank spreadsheet row exports as ",,,": not a data row.
    skip_records_with_empty_values: true,
    // Hand-typed files may leave commas unquoted in the trailing notes
    // column; they arrive as extra fields and are rejoined below.
    relax_column_count: true,
    info: true,
    // csv-parse's typings declare string[][] regardless of options; with
    // `info: true` each record is actually { record, info }.
  }) as unknown as ParsedRecord[];

  const header = (parsed[0]?.record ?? [])
    .map((field) => field.trim().toLowerCase())
    .join(',');
  if (header !== NAMED_HEADER && header !== LEGACY_HEADER) {
    throw new Error(`Unexpected CSV header. Expected exactly: ${NAMED_HEADER}`);
  }
  const offset = header === NAMED_HEADER ? 1 : 0;

  return parsed.slice(1).map((parsedRecord) => {
    const { record } = parsedRecord;
    const rowNumber = startingLine(parsedRecord);
    const field = (index: number) => (record[index] ?? '').trim();

    const memberId = field(0);
    const memberName = offset ? field(1) : '';
    const durationStr = field(1 + offset);
    const dateStr = field(2 + offset);
    // Untrimmed join, so an unquoted "late, again" keeps its space.
    const notes = record
      .slice(3 + offset)
      .join(',')
      .trim();

    if (!WHOLE_NUMBER.test(memberId)) {
      throw new Error(
        `Row ${rowNumber}: member_id must be a numeric Meetup member ID, got "${memberId}"`,
      );
    }
    // Not Number() alone: it accepts "1e1" as 10 and "0x1e" as 30.
    const durationDays = Number(durationStr);
    if (!WHOLE_NUMBER.test(durationStr) || durationDays <= 0) {
      throw new Error(
        `Row ${rowNumber}: duration_days must be a positive whole number, got "${durationStr}"`,
      );
    }
    const suspendedAt = parseUtcDateStrict(dateStr);
    if (suspendedAt === undefined) {
      throw new Error(
        `Row ${rowNumber}: suspended_at must be a real calendar date as YYYY-MM-DD, got "${dateStr}"`,
      );
    }
    return {
      memberId,
      memberName: memberName.length > 0 ? memberName : null,
      durationDays,
      suspendedAt,
      notes: notes.length > 0 ? notes : null,
      rowNumber,
    };
  });
}

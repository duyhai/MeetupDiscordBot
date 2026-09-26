/**
 * Parser for the /meetup_record_suspension CSV attachment. The same format
 * serves the one-time spreadsheet backfill and ongoing exception entries,
 * so errors must name the offending row — moderators fix the sheet, not us.
 */
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

// Strip a UTF-8 BOM, which some spreadsheet exports (e.g. Excel "CSV UTF-8")
// prepend to the file; left in place it would corrupt the header comparison
// below by attaching itself to "member_id".
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseSuspensionCsv(rawText: string): SuspensionInsert[] {
  const text = stripBom(rawText);
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? '').replaceAll(' ', '').toLowerCase();
  if (header !== NAMED_HEADER && header !== LEGACY_HEADER) {
    throw new Error(`Unexpected CSV header. Expected exactly: ${NAMED_HEADER}`);
  }
  const hasNameColumn = header === NAMED_HEADER;
  return lines
    .map((line, index) => ({ line: line.trim(), rowNumber: index + 1 }))
    .slice(1)
    .filter(({ line }) => line.length > 0)
    .map(({ line, rowNumber }) => {
      // notes may contain commas: split only the leading fixed fields.
      const parts = line.split(',').map((part) => part.trim());
      const memberId = parts[0];
      const memberName = hasNameColumn ? parts[1] : '';
      const [durationStr, dateStr, ...notesParts] = parts.slice(
        hasNameColumn ? 2 : 1,
      );
      const notes = notesParts.join(',').trim();
      const durationDays = Number(durationStr);
      if (!memberId || !Number.isInteger(durationDays) || durationDays <= 0) {
        throw new Error(
          `Row ${rowNumber}: invalid member_id or duration_days in "${line}"`,
        );
      }
      const date = parseUtcDateStrict(dateStr);
      if (date === undefined) {
        throw new Error(
          `Row ${rowNumber}: suspended_at must be YYYY-MM-DD in "${line}"`,
        );
      }
      return {
        memberId,
        memberName: memberName.length > 0 ? memberName : null,
        durationDays,
        suspendedAt: date,
        notes: notes.length > 0 ? notes : null,
      };
    });
}

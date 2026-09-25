/**
 * Parser for the /meetup_record_suspension CSV attachment. The same format
 * serves the one-time spreadsheet backfill and ongoing exception entries,
 * so errors must name the offending row — moderators fix the sheet, not us.
 */
import { SuspensionInsert } from '../repositories/types.js';

const EXPECTED_HEADER = 'member_id,duration_days,suspended_at,notes';
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

export function parseSuspensionCsv(text: string): SuspensionInsert[] {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? '').replaceAll(' ', '').toLowerCase();
  if (header !== EXPECTED_HEADER) {
    throw new Error(
      `Unexpected CSV header. Expected exactly: ${EXPECTED_HEADER}`,
    );
  }
  return lines
    .map((line, index) => ({ line: line.trim(), rowNumber: index + 1 }))
    .slice(1)
    .filter(({ line }) => line.length > 0)
    .map(({ line, rowNumber }) => {
      // notes may contain commas: split only the first three fields.
      const [memberId, durationStr, dateStr, ...notesParts] = line
        .split(',')
        .map((part) => part.trim());
      const notes = notesParts.join(',').trim();
      const durationDays = Number(durationStr);
      if (!memberId || !Number.isInteger(durationDays) || durationDays <= 0) {
        throw new Error(
          `Row ${rowNumber}: invalid member_id or duration_days in "${line}"`,
        );
      }
      if (!DATE_FORMAT.test(dateStr)) {
        throw new Error(
          `Row ${rowNumber}: suspended_at must be YYYY-MM-DD in "${line}"`,
        );
      }
      return {
        memberId,
        memberName: null,
        durationDays,
        suspendedAt: new Date(`${dateStr}T00:00:00Z`),
        notes: notes.length > 0 ? notes : null,
      };
    });
}

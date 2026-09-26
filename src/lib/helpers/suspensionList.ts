/**
 * Formatting for /meetup_list_suspensions. Pure so the active/past split --
 * which moderators act on directly -- is unit-testable.
 */
import dayjs from 'dayjs';

import { SuspensionRecord } from '../repositories/types.js';

function endDate(record: SuspensionRecord): dayjs.Dayjs {
  return dayjs(record.suspendedAt).add(record.durationDays, 'day');
}

// Suspension dates are stored as UTC midnights, so format them from the ISO
// string: local-time formatting would show the previous day in US timezones.
function utcDateOnly(date: Date | dayjs.Dayjs): string {
  return dayjs(date).toISOString().slice(0, 10);
}

function formatRecord(record: SuspensionRecord): string {
  const name = record.memberName ? ` (${record.memberName})` : '';
  const notes = record.notes ? ` — ${record.notes}` : '';
  return `- ${record.memberId}${name}: ${record.durationDays} days from ${utcDateOnly(
    record.suspendedAt,
  )} until ${utcDateOnly(endDate(record))}${notes}`;
}

export function formatSuspensionList(
  records: SuspensionRecord[],
  now: dayjs.Dayjs,
): string {
  if (records.length === 0) {
    return 'No suspensions recorded.';
  }
  const active = records.filter((record) => endDate(record).isAfter(now));
  const past = records.filter((record) => !endDate(record).isAfter(now));
  const sections = [
    `__Currently active (${active.length})__`,
    ...(active.length ? [active.map(formatRecord).join('\n')] : []),
    `__Past (${past.length})__`,
    ...(past.length ? [past.map(formatRecord).join('\n')] : []),
  ];
  return sections.join('\n\n');
}

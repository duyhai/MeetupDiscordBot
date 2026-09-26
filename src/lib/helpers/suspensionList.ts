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

function formatRecord(
  record: SuspensionRecord,
  fallbackNames: Map<string, string>,
): string {
  // The recorded name is the at-suspension snapshot and wins; the fallback
  // covers older rows recorded before names were captured.
  const memberName =
    record.memberName ?? fallbackNames.get(record.memberId) ?? null;
  const name = memberName ? ` (${memberName})` : '';
  const notes = record.notes ? ` — ${record.notes}` : '';
  // Plain URL, not a markdown link: this renders inside a .txt attachment.
  const profileUrl = `https://www.meetup.com/members/${record.memberId}/`;
  return `- ${record.memberId}${name}: ${record.durationDays} days from ${utcDateOnly(
    record.suspendedAt,
  )} until ${utcDateOnly(endDate(record))}${notes}\n  ${profileUrl}`;
}

export function formatSuspensionList(
  records: SuspensionRecord[],
  now: dayjs.Dayjs,
  fallbackNames: Map<string, string> = new Map(),
): string {
  if (records.length === 0) {
    return 'No suspensions recorded.';
  }
  const active = records.filter((record) => endDate(record).isAfter(now));
  const past = records.filter((record) => !endDate(record).isAfter(now));
  const format = (record: SuspensionRecord) =>
    formatRecord(record, fallbackNames);
  const sections = [
    `__Currently active (${active.length})__`,
    ...(active.length ? [active.map(format).join('\n')] : []),
    `__Past (${past.length})__`,
    ...(past.length ? [past.map(format).join('\n')] : []),
  ];
  return sections.join('\n\n');
}

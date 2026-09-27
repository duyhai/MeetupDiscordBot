/**
 * Formatting for /meetup_list_suspensions. Pure so the active/past split --
 * which moderators act on directly -- is unit-testable.
 */
import dayjs from 'dayjs';

import { SuspensionRecord } from '../repositories/types.js';
import { tz } from '../../util/timezone.js';

// Suspension dates are stored as UTC midnights, so format them from the ISO
// string: local-time formatting would show the previous day in US timezones.
export function utcDateOnly(date: Date | dayjs.Dayjs): string {
  return dayjs(date).toISOString().slice(0, 10);
}

/**
 * The last calendar day the member is suspended, inclusive: 30 days from
 * Sept 1 covers Sept 1 - Sept 30. Computed in UTC so day arithmetic is pure
 * calendar arithmetic -- adding days in local time can drift across a
 * daylight-saving change.
 */
export function lastSuspendedDay(record: SuspensionRecord): string {
  return dayjs
    .utc(record.suspendedAt)
    .add(record.durationDays - 1, 'day')
    .format('YYYY-MM-DD');
}

/**
 * Active through the whole of its last day in the group's timezone, not
 * until UTC midnight -- which is 5pm Pacific the evening before.
 */
function isActive(record: SuspensionRecord, now: dayjs.Dayjs): boolean {
  const today = tz(now).format('YYYY-MM-DD');
  return today <= lastSuspendedDay(record);
}

/**
 * Whether the suspension is in effect on a recording date. Unlike isActive,
 * this takes the calendar day as given: recording dates are already UTC
 * midnights naming the day, and reading one in the group's timezone would
 * shift it to the day before. The start bound matters when back-dating: a
 * later suspension doesn't cover an earlier date.
 */
export function coversDay(record: SuspensionRecord, day: Date): boolean {
  const date = utcDateOnly(day);
  return (
    utcDateOnly(record.suspendedAt) <= date && date <= lastSuspendedDay(record)
  );
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
  return `- #${record.id} ${record.memberId}${name}: ${record.durationDays} days from ${utcDateOnly(
    record.suspendedAt,
  )} through ${lastSuspendedDay(record)}${notes}\n  ${profileUrl}`;
}

export function formatSuspensionList(
  records: SuspensionRecord[],
  now: dayjs.Dayjs,
  fallbackNames: Map<string, string> = new Map(),
): string {
  if (records.length === 0) {
    return 'No suspensions recorded.';
  }
  const active = records.filter((record) => isActive(record, now));
  const past = records.filter((record) => !isActive(record, now));
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

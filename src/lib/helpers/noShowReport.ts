/**
 * Pure logic behind the monthly No Show report. The policy encoded here is
 * the group's moderation policy — see the Policy section of
 * docs/superpowers/specs/2026-09-24-monthly-reports-automation-design.md:
 *
 * - Count no-shows from the last 12 months (measured back from today), and
 *   only those after the member's most recent suspension.
 * - 1 countable no-show → warning; 2+ → suspension candidate.
 * - Suspension length: 30 days × 2^(prior suspensions).
 * - Act 3–5 days before the member's next RSVP'd event.
 *
 * Every date comparison is by Seattle calendar day: suspensions are stored as
 * date-only values, and an evening event is already the next day in UTC.
 */
import dayjs from 'dayjs';

import { BaseUserInfo, EventSummary } from '../client/meetup/types.js';
import { SuspensionRecord } from '../repositories/types.js';
import { linkStr } from '../../util/discord.js';
import { tz } from '../../util/timezone.js';
import { utcDateOnly } from './suspensionList.js';

/** An event's (or instant's) calendar day in the group's timezone. */
function localDay(dateTime: string | dayjs.Dayjs): string {
  return tz(dayjs(dateTime)).format('YYYY-MM-DD');
}

/** Only called with the count that survives `countableNoShows`. */
export function classifyNoShowCount(count: number): 'warning' | 'suspension' {
  // A count of zero means there is nothing to act on; classifying it as a
  // warning would warn a member who did nothing wrong.
  if (count < 1) {
    throw new RangeError(
      `classifyNoShowCount needs a count >= 1, got ${count}`,
    );
  }
  return count >= 2 ? 'suspension' : 'warning';
}

export function recommendedSuspensionDays(priorSuspensions: number): number {
  return 30 * 2 ** priorSuspensions;
}

export interface SuspensionHistory {
  priorCount: number;
  /** YYYY-MM-DD of the most recent suspension, if any. */
  lastSuspendedDay?: string;
}

/**
 * Summarises a member's (non-voided) suspension records. Every record counts
 * as prior: the suspension this report leads to will be dated today or
 * later, after all of them.
 */
export function suspensionHistory(
  records: SuspensionRecord[],
): SuspensionHistory {
  if (records.length === 0) {
    return { priorCount: 0 };
  }
  const days = records.map((record) => utcDateOnly(record.suspendedAt));
  return {
    priorCount: records.length,
    lastSuspendedDay: days.sort().at(-1),
  };
}

/** No-shows count only on days strictly after `day`. */
export interface CountingSince {
  day: string;
  reason: 'twelve-months' | 'last-suspension';
}

/**
 * The no-shows that count toward the next action: after 12 months ago and
 * after the most recent suspension (whichever is later), up to today.
 * The no-shows that led to a suspension never count toward the next one.
 */
export function countableNoShows(
  noShows: EventSummary[],
  history: SuspensionHistory,
  now: dayjs.Dayjs,
): { counted: EventSummary[]; since: CountingSince } {
  const twelveMonthsAgo = tz(now).subtract(12, 'month').format('YYYY-MM-DD');
  const since: CountingSince =
    history.lastSuspendedDay !== undefined &&
    history.lastSuspendedDay > twelveMonthsAgo
      ? { day: history.lastSuspendedDay, reason: 'last-suspension' }
      : { day: twelveMonthsAgo, reason: 'twelve-months' };
  const today = localDay(now);
  const byId = new Map(noShows.map((event) => [event.id, event]));
  const counted = [...byId.values()]
    .filter((event) => {
      const day = localDay(event.dateTime);
      return day > since.day && day <= today;
    })
    .sort((a, b) => dayjs(a.dateTime).valueOf() - dayjs(b.dateTime).valueOf());
  return { counted, since };
}

/**
 * The suspension should land at least 3 days before the next event, by
 * Seattle calendar day. Act now once that day has come.
 */
export function actByDate(
  nextEventIso: string,
  now: dayjs.Dayjs,
): { actBy: string; actNow: boolean } {
  const actBy = tz(dayjs(nextEventIso)).subtract(3, 'day').format('YYYY-MM-DD');
  return { actBy, actNow: actBy <= localDay(now) };
}

/** The earliest of `events` still ahead of `now`, if any. */
export function nextEvent(
  events: EventSummary[],
  now: dayjs.Dayjs,
): EventSummary | undefined {
  return events
    .filter((event) => dayjs(event.dateTime).isAfter(now))
    .sort((a, b) => dayjs(a.dateTime).valueOf() - dayjs(b.dateTime).valueOf())
    .at(0);
}

export type NoShowTally = Map<
  string,
  { member: BaseUserInfo; events: EventSummary[] }
>;

export function tallyNoShows(
  resultsPerEvent: {
    event: EventSummary;
    rsvps: { member: BaseUserInfo }[];
  }[],
): NoShowTally {
  const tally: NoShowTally = new Map();
  for (const { event, rsvps } of resultsPerEvent) {
    for (const { member } of rsvps) {
      const entry = tally.get(member.id) ?? { member, events: [] };
      entry.events.push(event);
      tally.set(member.id, entry);
    }
  }
  return tally;
}

export interface NoShowCase {
  member: BaseUserInfo;
  /** The countable no-shows, oldest first. */
  counted: EventSummary[];
  since: CountingSince;
  classification: 'warning' | 'suspension';
  priorSuspensions?: number;
  recommendedDays?: number;
  nextRsvpEvent?: EventSummary;
  /** YYYY-MM-DD. */
  actBy?: string;
  actNow?: boolean;
}

/** A member with month no-shows but none that count any more. */
export interface ClearedMember {
  member: BaseUserInfo;
  lastSuspendedDay?: string;
}

export interface NoShowCases {
  cases: NoShowCase[];
  cleared: ClearedMember[];
  /** No longer in the group, so their history can't be read. */
  departed: BaseUserInfo[];
}

/**
 * Classifies everyone with a no-show in the report month.
 *
 * `noShowsByMember` is each member's own no-show list (undefined when they
 * have left the group). The month's no-shows are merged in, so an event the
 * per-member list happens to omit still counts.
 */
export function buildNoShowCases({
  monthTally,
  noShowsByMember,
  historyByMember,
  now,
}: {
  monthTally: NoShowTally;
  noShowsByMember: Map<string, EventSummary[] | undefined>;
  historyByMember: Map<string, SuspensionHistory>;
  now: dayjs.Dayjs;
}): NoShowCases {
  const result: NoShowCases = { cases: [], cleared: [], departed: [] };
  for (const [memberId, { member, events: monthEvents }] of monthTally) {
    const memberNoShows = noShowsByMember.get(memberId);
    if (memberNoShows === undefined) {
      result.departed.push(member);
      continue;
    }
    const history = historyByMember.get(memberId) ?? { priorCount: 0 };
    const { counted, since } = countableNoShows(
      [...memberNoShows, ...monthEvents],
      history,
      now,
    );
    if (counted.length === 0) {
      result.cleared.push({
        member,
        lastSuspendedDay: history.lastSuspendedDay,
      });
      continue;
    }
    const classification = classifyNoShowCount(counted.length);
    result.cases.push({
      member,
      counted,
      since,
      classification,
      ...(classification === 'suspension' && {
        priorSuspensions: history.priorCount,
        recommendedDays: recommendedSuspensionDays(history.priorCount),
      }),
    });
  }
  return result;
}

function readableDay(day: string): string {
  return dayjs(day).format('ll');
}

function formatEventLine(event: EventSummary): string {
  return `    ${linkStr(event.title, event.eventUrl)} ${tz(
    dayjs(event.dateTime),
  ).format('LLL')}`;
}

function formatCase(noShowCase: NoShowCase): string {
  const { member, counted, since } = noShowCase;
  const reason =
    since.reason === 'last-suspension' ? 'last suspension' : '12 months ago';
  const lines = [
    `**${linkStr(member.name, member.memberUrl)} ID: ${member.id}** — ${
      counted.length
    } no-show${counted.length === 1 ? '' : 's'} since ${since.day} (${reason})`,
  ];
  if (noShowCase.classification === 'suspension') {
    lines.push(
      `    prior suspensions: ${noShowCase.priorSuspensions} → recommended: ${noShowCase.recommendedDays} days`,
    );
    const next = noShowCase.nextRsvpEvent;
    if (next && noShowCase.actBy) {
      const timing = noShowCase.actNow
        ? '**ACT NOW** (the event is 3 days away or less)'
        : `act by ${readableDay(
            noShowCase.actBy,
          )} (aim for 3–5 days before the event)`;
      lines.push(
        `    next RSVP: ${linkStr(next.title, next.eventUrl)} ${tz(
          dayjs(next.dateTime),
        ).format('LLL')} → ${timing}`,
      );
    } else {
      lines.push('    no upcoming RSVPs in the group — suspend at any time');
    }
  }
  lines.push(...counted.map(formatEventLine));
  return lines.join('\n');
}

export function formatNoShowReport(
  periodLabel: string,
  { cases, cleared, departed }: NoShowCases,
): string {
  const warnings = cases.filter((c) => c.classification === 'warning');
  const suspensions = cases.filter((c) => c.classification === 'suspension');
  const sections = [
    `**No Show report for ${periodLabel}**`,
    'Counted: no-shows in the last 12 months, after the member’s most recent suspension.',
    `__Warnings (1 no-show): ${warnings.length}__`,
    ...(warnings.length ? [warnings.map(formatCase).join('\n')] : []),
    `__Suspension candidates (2+ no-shows): ${suspensions.length}__`,
    ...(suspensions.length ? [suspensions.map(formatCase).join('\n')] : []),
  ];
  if (cleared.length) {
    sections.push(
      `__No action needed — this month's no-shows no longer count: ${cleared.length}__`,
      cleared
        .map(
          ({ member, lastSuspendedDay }) =>
            `${linkStr(member.name, member.memberUrl)} ID: ${member.id} — ${
              lastSuspendedDay
                ? `suspended ${lastSuspendedDay}`
                : 'older than 12 months'
            }`,
        )
        .join('\n'),
    );
  }
  if (departed.length) {
    sections.push(
      `__No longer in the group — not classified: ${departed.length}__`,
      departed
        .map(
          (member) =>
            `${linkStr(member.name, member.memberUrl)} ID: ${member.id}`,
        )
        .join('\n'),
    );
  }
  return sections.join('\n\n');
}

/**
 * Quotes a CSV field per RFC 4180, and defuses values a spreadsheet would
 * run as a formula: moderators edit this file in one before uploading it.
 */
function csvField(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/**
 * A ready-to-edit CSV of the suspension candidates, in the format
 * /meetup_record_suspension accepts. `suspended_at` is deliberately blank:
 * the recorder refuses the file until the moderator enters the day each
 * suspension was actually applied, so a guessed date can't be recorded by
 * accident. Returns undefined when nobody is a suspension candidate.
 */
export function formatSuspensionCsv(cases: NoShowCase[]): string | undefined {
  const suspensions = cases.filter((c) => c.classification === 'suspension');
  if (suspensions.length === 0) {
    return undefined;
  }
  const rows = suspensions.map((c) => {
    const notes = [
      ...(c.actBy ? [`act by ${c.actBy}`] : []),
      `${c.counted.length} no-shows since ${c.since.day}`,
      `prior suspensions: ${c.priorSuspensions}`,
    ].join('; ');
    return [c.member.id, c.member.name, String(c.recommendedDays), '', notes]
      .map(csvField)
      .join(',');
  });
  return [
    'member_id,member_name,duration_days,suspended_at,notes',
    ...rows,
  ].join('\n');
}

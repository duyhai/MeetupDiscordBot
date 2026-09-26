/**
 * Pure logic behind the monthly No Show report. The policy encoded here
 * (warn at 1, suspend at 2+, 30 days doubling per prior suspension, act 3
 * days before the member's next event) is the group's moderation policy —
 * see docs/superpowers/specs/2026-09-24-monthly-reports-automation-design.md.
 */
import dayjs from 'dayjs';

import { BaseUserInfo, Event } from '../client/meetup/types.js';
import { linkStr } from '../../util/discord.js';
import { tz } from '../../util/timezone.js';

export function classifyNoShowCount(count: number): 'warning' | 'suspension' {
  return count >= 2 ? 'suspension' : 'warning';
}

export function recommendedSuspensionDays(priorSuspensions: number): number {
  return 30 * 2 ** priorSuspensions;
}

/** The suspension should land at least 3 days before the next event. */
export function actByDate(
  nextEventIso: string,
  now: dayjs.Dayjs,
): { actBy: dayjs.Dayjs; actNow: boolean } {
  const actBy = dayjs(nextEventIso).subtract(3, 'day');
  return { actBy, actNow: !actBy.isAfter(now) };
}

export function tallyNoShows(
  resultsPerEvent: { event: Event; rsvps: { member: BaseUserInfo }[] }[],
): Map<string, { member: BaseUserInfo; events: Event[] }> {
  const tally = new Map<string, { member: BaseUserInfo; events: Event[] }>();
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
  monthEvents: Event[];
  twelveMonthCount: number;
  classification: 'warning' | 'suspension';
  priorSuspensions?: number;
  recommendedDays?: number;
  nextRsvpEvent?: Event;
  actBy?: string;
  actNow?: boolean;
}

function formatEventLine(event: Event): string {
  return `    ${linkStr(event.title, event.eventUrl)} ${tz(
    dayjs(event.dateTime),
  ).format('LLL')}`;
}

function formatCase(noShowCase: NoShowCase): string {
  const { member, monthEvents, twelveMonthCount } = noShowCase;
  const header = `**${linkStr(member.name, member.memberUrl)} ID: ${
    member.id
  }** — ${twelveMonthCount} no-show${
    twelveMonthCount === 1 ? '' : 's'
  } in the last 12 months`;
  const lines = [header];
  if (noShowCase.classification === 'suspension') {
    lines.push(
      `    prior suspensions: ${noShowCase.priorSuspensions} → recommended: ${noShowCase.recommendedDays} days`,
    );
    if (noShowCase.nextRsvpEvent) {
      const timing = noShowCase.actNow
        ? `**ACT NOW** (event is within 3 days)`
        : `act by ${noShowCase.actBy}`;
      lines.push(
        `    next RSVP: ${linkStr(
          noShowCase.nextRsvpEvent.title,
          noShowCase.nextRsvpEvent.eventUrl,
        )} ${tz(dayjs(noShowCase.nextRsvpEvent.dateTime)).format(
          'LLL',
        )} → ${timing}`,
      );
    } else {
      lines.push('    no upcoming RSVPs — suspend at any time');
    }
  }
  lines.push(...monthEvents.map(formatEventLine));
  return lines.join('\n');
}

export function formatNoShowReport(
  periodLabel: string,
  cases: NoShowCase[],
): string {
  const warnings = cases.filter((c) => c.classification === 'warning');
  const suspensions = cases.filter((c) => c.classification === 'suspension');
  const sections = [`**No Show report for ${periodLabel}**`];
  sections.push(
    `__Warnings (1 no-show in 12 months): ${warnings.length}__`,
    ...(warnings.length ? [warnings.map(formatCase).join('\n')] : []),
  );
  sections.push(
    `__Suspension candidates (2+ no-shows in 12 months): ${suspensions.length}__`,
    ...(suspensions.length ? [suspensions.map(formatCase).join('\n')] : []),
  );
  return sections.join('\n\n');
}

/**
 * A ready-to-edit CSV of the report's suspension candidates, in exactly the
 * format /meetup_record_suspension's csv option accepts. Moderators delete
 * or amend rows before uploading, so the report and the recording command
 * stay one copy-free loop. Returns undefined when nothing classifies as a
 * suspension.
 */
export function formatSuspensionCsv(
  cases: NoShowCase[],
  suspendedAt: string,
): string | undefined {
  const suspensions = cases.filter((c) => c.classification === 'suspension');
  if (suspensions.length === 0) {
    return undefined;
  }
  const rows = suspensions.map((noShowCase) => {
    const notes = `${noShowCase.twelveMonthCount} no-shows in 12 months; prior suspensions: ${noShowCase.priorSuspensions}`;
    return `${noShowCase.member.id},${noShowCase.recommendedDays},${suspendedAt},${notes}`;
  });
  return ['member_id,duration_days,suspended_at,notes', ...rows].join('\n');
}

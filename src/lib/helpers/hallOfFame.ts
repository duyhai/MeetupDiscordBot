/**
 * Pure logic behind the monthly Hall of Fame post. Kept separate from the
 * Discord command so the counting and formatting that moderators quote
 * publicly is unit-testable.
 */
import dayjs from 'dayjs';

import { BaseUserInfo, Event, EventStatus } from '../client/meetup/types.js';
import { tz } from '../../util/timezone.js';

const CANCELLED_TITLE = /cancell?ed/i;
const CANCELLED_STATUSES: EventStatus[] = [
  'CANCELLED',
  'CANCELLED_PERM',
  'AUTOSCHED_CANCELLED',
];

/**
 * Hosts sometimes rename an event "cancelled" instead of cancelling it on
 * the platform, so the title check matters even though the group-events
 * query never requests cancelled statuses.
 */
export function isCancelledEvent(
  event: Pick<Event, 'title' | 'status'>,
): boolean {
  return (
    CANCELLED_TITLE.test(event.title) ||
    CANCELLED_STATUSES.includes(event.status)
  );
}

export interface HostStats {
  host: BaseUserInfo;
  events: Event[];
}

/**
 * Whether an event counts toward the Hall of Fame. Cancelled events never
 * happened, and an [Open House] is not a hosted event in the stats' sense --
 * it isn't invalid, it just doesn't count.
 *
 * AUTOSCHED events don't count either: a recurring series can generate a
 * copy of an event that already exists, and the copy stays AUTOSCHED
 * instead of becoming PAST. Checked 2026-09-28 against every 2026 event:
 * all 11 past-dated AUTOSCHED events were such copies (same title and start
 * time as a PAST event, 1-2 RSVPs), and no real event was left AUTOSCHED.
 */
export function isCountableEvent(
  event: Pick<Event, 'title' | 'status'>,
): boolean {
  return (
    !isCancelledEvent(event) &&
    event.status !== 'AUTOSCHED' &&
    !event.title.includes('[Open House]')
  );
}

/**
 * Groups events by host, deduping hosts within a single event. totalEvents
 * counts each event once regardless of how many hosts it has.
 *
 * Does no filtering: it counts every event it is given. Callers filter with
 * isCountableEvent first, so the rule for what counts stays visible at the
 * call site rather than hidden inside a function named for grouping.
 */
export function collectHostStats(events: Event[]): {
  hostStats: HostStats[];
  totalEvents: number;
} {
  const byHost = new Map<string, HostStats>();
  for (const event of events) {
    const seen = new Set<string>();
    for (const { member } of event.eventHosts) {
      if (seen.has(member.id)) {
        continue;
      }
      seen.add(member.id);
      const stats = byHost.get(member.id) ?? { host: member, events: [] };
      stats.events.push(event);
      byHost.set(member.id, stats);
    }
  }
  const hostStats = Array.from(byHost.values()).sort(
    (a, b) => b.events.length - a.events.length,
  );
  return { hostStats, totalEvents: events.length };
}

/**
 * The distinct events a Hall of Fame displays. Callers fetch attendance for
 * exactly these, so the fetch set is derived from the display set rather than
 * re-deriving it from the raw events -- a second derivation could drift, and
 * an event shown but never fetched renders as (0/N) attendance.
 */
export function displayedEvents(hostStats: HostStats[]): Event[] {
  const byId = new Map<string, Event>();
  for (const { events } of hostStats) {
    for (const event of events) {
      byId.set(event.id, event);
    }
  }
  return Array.from(byId.values());
}

function collapseByTitle(events: Event[]): string[] {
  const byTitle = new Map<string, Event[]>();
  for (const event of events) {
    const group = byTitle.get(event.title) ?? [];
    group.push(event);
    byTitle.set(event.title, group);
  }
  return Array.from(byTitle.entries()).map(([title, group]) => {
    const dates = group
      .map((event) => tz(dayjs(event.dateTime)).format('MMM D'))
      .join(', ');
    const suffix = group.length > 1 ? ` ×${group.length}` : '';
    return `${title}${suffix} (${dates})`;
  });
}

/** Co-hosts of a member across their events this period, deduped. */
function coHostsOf(hostId: string, events: Event[]): BaseUserInfo[] {
  const coHosts = new Map<string, BaseUserInfo>();
  for (const event of events) {
    for (const { member } of event.eventHosts) {
      if (member.id !== hostId) {
        coHosts.set(member.id, member);
      }
    }
  }
  return Array.from(coHosts.values());
}

export function formatHallOfFamePost(input: {
  periodLabel: string;
  hostStats: HostStats[];
  totalEvents: number;
  newHostIds: Set<string>;
}): string {
  const { periodLabel, hostStats, totalEvents, newHostIds } = input;
  const rankings = hostStats
    .map((stats, index) => {
      const flag = newHostIds.has(stats.host.id) ? ' 🆕' : '';
      const header = `**#${index + 1}: ${stats.host.name} — ${
        stats.events.length
      } event${stats.events.length === 1 ? '' : 's'}**${flag}`;
      const body = collapseByTitle(stats.events)
        .map((line) => `    ${line}`)
        .join('\n');
      return `${header}\n${body}`;
    })
    .join('\n');

  const newHosts = hostStats.filter((stats) => newHostIds.has(stats.host.id));
  const newHostSection =
    newHosts.length === 0
      ? ''
      : `\n\nNew hosts: ${newHosts
          .map((stats) => {
            const coHosts = coHostsOf(stats.host.id, stats.events);
            const coHostStr =
              coHosts.length === 0
                ? 'no co-hosts'
                : `co-hosts: ${coHosts.map((m) => m.name).join(', ')}`;
            return `${stats.host.name} (${coHostStr})`;
          })
          .join('; ')}`;

  return `**Hall of Fame — ${periodLabel}**

${rankings}${newHostSection}

**Hosts: ${hostStats.length} · Events: ${totalEvents}**`;
}

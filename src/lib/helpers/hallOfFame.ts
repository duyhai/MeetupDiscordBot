/**
 * Pure logic behind the monthly Hall of Fame post. Kept separate from the
 * Discord command so the counting and formatting that moderators quote
 * publicly is unit-testable.
 */
import { BaseUserInfo, Event, EventStatus } from '../client/meetup/types.js';

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
 * Groups countable events (not cancelled, not [Open House]) by host,
 * deduping hosts within a single event. totalEvents counts each event once
 * regardless of how many hosts it has.
 */
export function collectHostStats(events: Event[]): {
  hostStats: HostStats[];
  totalEvents: number;
} {
  const countable = events.filter(
    (event) =>
      !isCancelledEvent(event) && !event.title.includes('[Open House]'),
  );
  const byHost = new Map<string, HostStats>();
  for (const event of countable) {
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
  return { hostStats, totalEvents: countable.length };
}

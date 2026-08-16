/**
 * Pure counting helpers behind the Meetup activity badges. Kept separate from
 * the fetching so the arithmetic that drives reward roles and linked-role
 * metadata is unit-testable: a dropped filter here silently hands everyone the
 * same inflated badge.
 */

interface HasMemberId {
  member: { id: string };
}

/**
 * Number of events whose RSVP list includes the member. Takes one RSVP page
 * list per event (the shape `Promise.all` over per-event fetches produces).
 */
export function countAttendedEvents(
  rsvpsPerEvent: HasMemberId[][],
  memberId: string,
): number {
  return rsvpsPerEvent.filter((rsvps) =>
    rsvps.some(({ member }) => member.id === memberId),
  ).length;
}

/** Number of events the member is listed as a host of. */
export function countHostedEvents(
  events: { eventHosts: HasMemberId[] }[],
  memberId: string,
): number {
  return events.filter(({ eventHosts }) =>
    eventHosts.some(({ member }) => member.id === memberId),
  ).length;
}

interface MemberEvent {
  dateTime: string;
  group?: { id: string };
  id: string;
}

/**
 * Number of the member's own past events within one group.
 *
 * Meetup's `self.memberEvents` is scoped to the member, not the group, so it
 * spans every group they belong to and its `totalCount` cannot be used
 * directly -- a probe returned a Godot Seattle event next to ours. Counting
 * the member's own events (tens) replaces scanning the group's entire event
 * history and paginating every RSVP of every event (thousands of requests
 * held in memory at once, which was exhausting the dyno's memory quota).
 */
export function countMemberEventsInGroup(
  events: MemberEvent[],
  groupId: string,
): number {
  const now = Date.now();
  const counted = new Set<string>();
  events.forEach((event) => {
    if (event.group?.id !== groupId) {
      return;
    }
    if (new Date(event.dateTime).getTime() >= now) {
      return;
    }
    counted.add(event.id);
  });
  return counted.size;
}

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

import { Logger } from 'tslog';

import Configuration from '../../configuration.js';
import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { getPaginatedData } from '../client/meetup/paginationHelper.js';
import { countMemberEventsInGroup } from './eventStats.js';

const logger = new Logger({ name: 'badgeCounts' });

export interface BadgeCounts {
  attendedCount: number;
  hostedCount: number;
}

/**
 * Hosted and attended counts for the member behind this client.
 *
 * Asks Meetup about the member rather than the group. The previous approach
 * paginated every past event of the group (~1,400) and then, via Promise.all,
 * every RSVP page of every one of those events -- thousands of requests held
 * in memory simultaneously, which exhausted the dyno's memory quota (R14) and
 * flooded the log badly enough to destroy its retention. `self.memberEvents`
 * answers both questions from the member's own event list instead: a few
 * requests, bounded by their activity rather than the group's history.
 *
 * The counts are group-filtered client-side because memberEvents spans every
 * group the member belongs to; its totalCount is therefore not usable here.
 */
export async function getBadgeCounts(
  meetupClient: GqlMeetupClient,
): Promise<BadgeCounts> {
  const { groupId } = Configuration.meetup;

  const hostedEvents = await getPaginatedData(async (paginationInput) => {
    const result = await meetupClient.getUserHostedEvents(paginationInput);
    return result.self.memberEvents;
  });
  const attendedEvents = await getPaginatedData(async (paginationInput) => {
    const result = await meetupClient.getUserAttendedEvents(paginationInput);
    return result.self.memberEvents;
  });

  const counts = {
    hostedCount: countMemberEventsInGroup(hostedEvents, groupId),
    attendedCount: countMemberEventsInGroup(attendedEvents, groupId),
  };
  logger.info(
    `Badge counts from ${hostedEvents.length} hosted and ${attendedEvents.length} attended member events: ${JSON.stringify(counts)}`,
  );
  return counts;
}

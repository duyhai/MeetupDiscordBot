import { Logger } from 'tslog';

import Configuration from '../../configuration.js';
import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { getPaginatedData } from '../client/meetup/paginationHelper.js';

const logger = new Logger({ name: 'badgeCounts' });

export interface BadgeCounts {
  attendedCount: number;
  hostedCount: number;
}

/**
 * Hosted and attended counts for the member behind this client.
 *
 * Both questions are answered by server-side filters instead of scanning the
 * group. The previous approach paginated every past event of the group
 * (~1,400) and then, through Promise.all, every RSVP page of each of those
 * events -- thousands of requests resident at once, which exhausted the
 * dyno's memory quota and flooded the log badly enough to destroy retention.
 *
 * Attendance uses self.rsvps with rsvpStatus [YES, ATTENDED], the same statuses
 * the old per-event scan filtered on, so the counts keep their meaning.
 *
 * Note for anyone extending this: self.memberEvents looks like the natural
 * source but serves only UPCOMING events -- eventStatus: PAST returns nothing
 * there, and its membershipsFilter does not appear to apply. Counting from it
 * silently yields zero, which strips every member's badges.
 */
export async function getBadgeCounts(
  meetupClient: GqlMeetupClient,
): Promise<BadgeCounts> {
  const { groupId } = Configuration.meetup;
  const userInfo = await meetupClient.getUserInfo();

  const attendedCount = await meetupClient.getSelfPastRsvpCount(groupId);

  // Server-filtered by hostId, so this pages over the member's own hosted
  // events rather than the group's history. Same query getUserRoles already
  // relies on for the guest_host role.
  const hostedEvents = await getPaginatedData(async (paginationInput) => {
    const result = await meetupClient.getGroupEvents(paginationInput, {
      status: ['PAST'],
      hostId: userInfo.self.id,
    });
    return result.groupByUrlname.events;
  });

  const counts = { hostedCount: hostedEvents.length, attendedCount };
  logger.info(`Badge counts: ${JSON.stringify(counts)}`);
  return counts;
}

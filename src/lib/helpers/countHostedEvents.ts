import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { getPaginatedData } from '../client/meetup/paginationHelper.js';
import { countsAsHosted } from './countedEvents.js';

/** The one Meetup read this needs; a fake in tests. */
export type HostedEventsReader = Pick<GqlMeetupClient, 'getGroupEvents'>;

/**
 * How many PAST group events a member hosted that count as hosted
 * (countedEvents.ts): the events are listed with Meetup's hostId filter and
 * filtered here. Meetup's totalCount cannot be used, since it counts
 * cancelled events and Open Houses too. `before` keeps to events that
 * started before that instant (getGroupEvents pads beforeDateTime by a
 * month for the request and trims the result back to the window).
 *
 * One listing per call: a member's hosted events are a few pages at most,
 * unlike the group's history.
 */
export async function countHostedEvents(
  meetup: HostedEventsReader,
  hostId: string,
  options: { before?: Date } = {},
): Promise<number> {
  const events = await getPaginatedData(async (pagination) => {
    const result = await meetup.getGroupEvents(pagination, {
      status: ['PAST'],
      hostId,
      ...(options.before
        ? { beforeDateTime: options.before.toISOString() }
        : {}),
    });
    return result.groupByUrlname.events;
  });
  return events.filter(countsAsHosted).length;
}

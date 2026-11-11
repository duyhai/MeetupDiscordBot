/**
 * The snapshot's Meetup reads, every call counted against the tick's budget.
 * Organizer client only; ids and statuses only.
 */
import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { getPaginatedData } from '../client/meetup/paginationHelper.js';
import { PaginatedData, SnapshotRsvpNode } from '../client/meetup/types.js';
import {
  SnapshotEvent,
  SnapshotRsvp,
  toSnapshotEvent,
  toSnapshotRsvp,
} from './meetup.js';

export type SnapshotMeetup = Pick<
  GqlMeetupClient,
  'getGroupEventsForSnapshot' | 'getEventRsvpsForSnapshot'
>;

export interface CallCounter {
  n: number;
}

/** Thrown inside the page walk when the event's first page is null. */
class NoSuchEvent extends Error {}

/**
 * Every PAST and CANCELLED page, then every ACTIVE page (an id in both: the
 * ACTIVE copy wins, as in the event audit). `pastSeen` counts the validated
 * PAST events, for the short-listing guard.
 */
export async function listAllEvents(
  meetup: SnapshotMeetup,
  calls: CallCounter,
): Promise<{ events: SnapshotEvent[]; pastSeen: number; dropped: number }> {
  const byId = new Map<string, SnapshotEvent>();
  let dropped = 0;
  for (const status of [['PAST', 'CANCELLED'], ['ACTIVE']] as const) {
    // eslint-disable-next-line no-await-in-loop -- two listings, in order
    const nodes = await getPaginatedData((input) => {
      calls.n += 1;
      return meetup.getGroupEventsForSnapshot(input, { status: [...status] });
    });
    nodes.forEach((node) => {
      const event = toSnapshotEvent(node);
      if (event) {
        byId.set(event.eventId, event);
      } else {
        dropped += 1;
      }
    });
  }
  const events = [...byId.values()];
  return {
    events,
    pastSeen: events.filter((e) => e.status === 'PAST').length,
    dropped,
  };
}

/** Every page of the event's YES, WAITLIST and ATTENDED RSVPs; null when Meetup has no such event. */
export async function readEventRsvps(
  meetup: SnapshotMeetup,
  eventId: string,
  calls: CallCounter,
): Promise<SnapshotRsvp[] | null> {
  try {
    const nodes = await getPaginatedData(
      async (input): Promise<PaginatedData<SnapshotRsvpNode>> => {
        calls.n += 1;
        const result = await meetup.getEventRsvpsForSnapshot(eventId, input);
        if (result === null) {
          throw new NoSuchEvent();
        }
        return result;
      },
    );
    return nodes.flatMap((node) => {
      const rsvp = toSnapshotRsvp(node);
      return rsvp ? [rsvp] : [];
    });
  } catch (error) {
    if (error instanceof NoSuchEvent) {
      return null;
    }
    throw error;
  }
}

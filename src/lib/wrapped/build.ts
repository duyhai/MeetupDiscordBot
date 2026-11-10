/**
 * Builds a member's Wrapped from Meetup. Every read uses the client it is
 * handed (the member's own token); the organizer credential is a fallback
 * for the RSVP history alone, taken only when the member's own read throws.
 */
import { Logger } from 'tslog';

import {
  getPaginatedData,
  mapWithConcurrency,
} from '../client/meetup/paginationHelper.js';
import {
  EventSummary,
  GetEventRsvpsResponse,
  GetGroupEventsResponse,
  GroupEventFilter,
  PaginationInput,
  RsvpFilter,
} from '../client/meetup/types.js';
import { CachedWrapped } from './cache.js';
import { CompanionDeps, nameCompanions } from './companions.js';
import { WrappedEvent, computeWrapped, isInYear } from './stats.js';

const logger = new Logger({ name: 'wrappedBuild' });

/** One cached attendee-list fetch per event this year; keep the fan-out tame. */
export const ATTENDEE_FETCH_CONCURRENCY = 5;

/** The same filter Where have we met? uses, so cached lists are shared. */
const ATTENDEE_FILTER: RsvpFilter = { rsvpStatus: ['ATTENDED', 'YES'] };

/** The slice of GqlMeetupClient a build reads. */
export interface WrappedMeetup {
  getSelfPastRsvpEvents(
    groupId: string,
  ): Promise<{ events: EventSummary[]; meetupId: string }>;
  getGroupEvents(
    input: PaginationInput,
    filter?: GroupEventFilter,
  ): Promise<GetGroupEventsResponse>;
  getEventRsvps(
    eventId: string,
    input: PaginationInput,
    filter?: RsvpFilter,
  ): Promise<GetEventRsvpsResponse>;
}

export interface BuildDeps extends CompanionDeps {
  meetup: WrappedMeetup;
  /**
   * Organizer-credential fallback: the member's past yes/attended RSVPs;
   * undefined when they are not in the group.
   */
  organizerRsvps(meetupId: string): Promise<EventSummary[] | undefined>;
  onProgress?(message: string): Promise<void>;
  now?: () => Date;
}

export type BuildResult =
  | { kind: 'built'; wrapped: CachedWrapped }
  | { kind: 'account-mismatch'; tokenMeetupId: string }
  | { kind: 'not-in-group' };

type History =
  | { kind: 'events'; events: EventSummary[] }
  | { kind: 'account-mismatch'; tokenMeetupId: string }
  | { kind: 'not-in-group' };

async function readHistory(
  deps: BuildDeps,
  linkedMeetupId: string,
  groupId: string,
): Promise<History> {
  try {
    const { events, meetupId } =
      await deps.meetup.getSelfPastRsvpEvents(groupId);
    if (meetupId !== linkedMeetupId) {
      return { kind: 'account-mismatch', tokenMeetupId: meetupId };
    }
    return { kind: 'events', events };
  } catch (error) {
    logger.warn(
      `Member read of RSVP history failed, falling back to the organizer credential: ${String(error)}`,
    );
    const events = await deps.organizerRsvps(linkedMeetupId);
    return events ? { kind: 'events', events } : { kind: 'not-in-group' };
  }
}

async function readHosted(
  meetup: WrappedMeetup,
  hostId: string,
): Promise<WrappedEvent[]> {
  return getPaginatedData(async (paginationInput) => {
    const result = await meetup.getGroupEvents(paginationInput, {
      status: ['PAST'],
      hostId,
    });
    return result.groupByUrlname.events;
  });
}

async function readAttendees(
  meetup: WrappedMeetup,
  events: WrappedEvent[],
): Promise<Record<string, string[]>> {
  const lists = await mapWithConcurrency(
    events,
    ATTENDEE_FETCH_CONCURRENCY,
    async (event) => {
      const rsvps = await getPaginatedData(async (paginationInput) => {
        const result = await meetup.getEventRsvps(
          event.id,
          paginationInput,
          ATTENDEE_FILTER,
        );
        return result.event.rsvps;
      });
      return rsvps.map((rsvp) => rsvp.member.id);
    },
  );
  return Object.fromEntries(events.map((event, i) => [event.id, lists[i]]));
}

export async function buildWrapped(
  deps: BuildDeps,
  linkedMeetupId: string,
  year: number,
  groupId: string,
): Promise<BuildResult> {
  const progress = async (message: string) => {
    if (deps.onProgress) {
      await deps.onProgress(message);
    }
  };

  await progress('Reading your RSVPs…');
  const history = await readHistory(deps, linkedMeetupId, groupId);
  if (history.kind !== 'events') {
    return history;
  }
  const hosted = await readHosted(deps.meetup, linkedMeetupId);

  await progress('Finding who you went with…');
  // Deduped: a hosted event is usually in the RSVP list too, and each
  // event's attendee list should be fetched once.
  const thisYear = [
    ...new Map(
      [...history.events, ...hosted].map((event) => [event.id, event]),
    ).values(),
  ].filter((event) => isInYear(event.dateTime, year));
  const attendeesByEvent = await readAttendees(deps.meetup, thisYear);

  const { stats, companions } = computeWrapped({
    year,
    selfMeetupId: linkedMeetupId,
    attended: history.events,
    hosted,
    attendeesByEvent,
  });
  const named = await nameCompanions(companions, deps);
  return {
    kind: 'built',
    wrapped: {
      stats,
      companions: named,
      builtAt: (deps.now ?? (() => new Date()))().toISOString(),
    },
  };
}

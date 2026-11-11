/**
 * Builds a member's Wrapped from Meetup. Every read uses the client it is
 * handed (the member's own token); the organizer credential is a fallback
 * for the RSVP history alone, taken only when the member's own read throws.
 */
import { Logger } from 'tslog';

import { isMeetupUnauthorized } from '../helpers/organizerMeetupClient.js';
import {
  getPaginatedData,
  mapWithConcurrency,
} from '../client/meetup/paginationHelper.js';
import {
  EventSummary,
  GetEventRsvpsResponse,
  GetHostedEventsResponse,
  PaginationInput,
  RsvpFilter,
  hostedAttendance,
} from '../client/meetup/types.js';
import { CachedWrapped } from './cache.js';
import { earlyEventIdsToFetch, rankCohort } from './cohort.js';
import { CompanionDeps, nameCohort, nameCompanions } from './companions.js';
import {
  HostedEvent,
  WrappedEvent,
  computeWrapped,
  isInYear,
} from './stats.js';

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
  getHostedEvents(
    hostId: string,
    input: PaginationInput,
  ): Promise<GetHostedEventsResponse>;
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
  /**
   * Asked once the member's history is readable, right before the costly
   * part. Returning false stops the build ('rate-limited'), so a member whose
   * account is mismatched or out of the group never spends their hourly slot.
   */
  claimBuild?(): boolean;
  onProgress?(message: string): Promise<void>;
  now?: () => Date;
  /** Where the duration line goes (ids only); the module logger by default. */
  log?: (message: string) => void;
}

export type BuildResult =
  | { kind: 'built'; wrapped: CachedWrapped }
  | { kind: 'account-mismatch'; tokenMeetupId: string }
  | { kind: 'not-in-group' }
  | { kind: 'rate-limited' };

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
    // Only a refused token means the member's own view can't see the data.
    // Anything else (network, 5xx, GraphQL error) propagates: falling back
    // would skip the account check and the build would then carry on with
    // the same failing token anyway.
    if (!isMeetupUnauthorized(error)) {
      throw error;
    }
    // Name and status only: a Meetup body never reaches a log line here.
    logger.warn(
      'Member token refused (HTTP 401) reading RSVP history; ' +
        'falling back to the organizer credential',
    );
    const events = await deps.organizerRsvps(linkedMeetupId);
    return events ? { kind: 'events', events } : { kind: 'not-in-group' };
  }
}

async function readHosted(
  meetup: WrappedMeetup,
  hostId: string,
): Promise<HostedEvent[]> {
  const nodes = await getPaginatedData(async (paginationInput) => {
    const result = await meetup.getHostedEvents(hostId, paginationInput);
    return result.groupByUrlname.events;
  });
  return nodes.map(({ id, title, dateTime, eventUrl, ...node }) => ({
    id,
    title,
    dateTime,
    eventUrl,
    attendance: hostedAttendance({ id, title, dateTime, eventUrl, ...node }),
  }));
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

  const now = deps.now ?? (() => new Date());
  const startedMs = now().getTime();

  await progress('Reading your RSVPs…');
  const history = await readHistory(deps, linkedMeetupId, groupId);
  if (history.kind !== 'events') {
    return history;
  }
  if (deps.claimBuild && !deps.claimBuild()) {
    return { kind: 'rate-limited' };
  }
  const hosted = await readHosted(deps.meetup, linkedMeetupId);

  await progress('Finding who you went with…');
  // Deduped: a hosted event is usually in the RSVP list too, and each
  // event's attendee list should be fetched once.
  const everyEvent = new Map<string, WrappedEvent>(
    [...history.events, ...hosted].map(({ id, title, dateTime, eventUrl }) => [
      id,
      { id, title, dateTime, eventUrl },
    ]),
  );
  const thisYear = [...everyEvent.values()].filter((event) =>
    isInYear(event.dateTime, year),
  );
  const attendeesByEvent = await readAttendees(deps.meetup, thisYear);

  const { stats, companions } = computeWrapped({
    year,
    selfMeetupId: linkedMeetupId,
    attended: history.events,
    hosted,
    attendeesByEvent,
  });

  await progress('Looking back at your early events…');
  // Each top type's first events, fetched once (never again for one already
  // read this year), bounded by TOP_TYPES × FIRST_EVENTS_PER_TYPE.
  const earlyEvents = earlyEventIdsToFetch(
    stats.topTypes,
    Object.keys(attendeesByEvent),
  )
    .map((id) => everyEvent.get(id))
    .filter((event): event is WrappedEvent => event !== undefined);
  Object.assign(
    attendeesByEvent,
    await readAttendees(deps.meetup, earlyEvents),
  );
  const topTypes = await mapWithConcurrency(stats.topTypes, 1, async (top) => ({
    ...top,
    cohort: await nameCohort(
      rankCohort(top.firstEvents, attendeesByEvent, companions, linkedMeetupId),
      deps,
    ),
  }));

  const named = await nameCompanions(companions, deps, everyEvent);

  (deps.log ?? ((message: string) => logger.info(message)))(
    `Wrapped build for Meetup member ${linkedMeetupId} (${year}) took ${now().getTime() - startedMs} ms`,
  );
  return {
    kind: 'built',
    wrapped: {
      meetupId: linkedMeetupId,
      stats: { ...stats, topTypes },
      companions: named,
      builtAt: now().toISOString(),
    },
  };
}

import { Logger } from 'tslog';

import {
  EventCreator,
  createEventWithPhotoFallback,
} from '../client/meetup/createEventWithPhotoFallback.js';
import {
  CloseEventRsvpsInput,
  CreateEventResponse,
  EditEventInput,
} from '../client/meetup/types.js';
import { LogEntry } from '../helpers/discordLogger.js';
import {
  EventRequest,
  PublishFrom,
} from '../repositories/postgresEventRequestRepository.js';
import type { HostTier } from './eligibility.js';
import { createInputFor } from './eventRequest.js';

const logger = new Logger({ name: 'publishRequest' });

/** A 'publishing' request untouched for this long has lost its publisher. */
export const STUCK_PUBLISHING_MS = 10 * 60 * 1000;

/** The organizer client's writes this path makes (GqlMeetupClient has them). */
export interface OrganizerWriter extends EventCreator {
  closeEventRsvps(input: CloseEventRsvpsInput): Promise<unknown>;
  editEvent(input: EditEventInput): Promise<unknown>;
}

export interface PublishDeps {
  /** PostgresEventRequestRepository's publish steps. */
  requests: {
    startPublishing: (
      id: string,
      seenVersion: number,
      actor: string,
      from: PublishFrom[],
      stuckBefore?: Date,
    ) => Promise<EventRequest | undefined>;
    recordCreated: (
      id: string,
      eventId: string,
      eventUrl: string,
    ) => Promise<void>;
    finish: (
      id: string,
      outcome: { status: 'published' } | { status: 'failed'; failure: string },
    ) => Promise<EventRequest | undefined>;
  };
  /**
   * A client on the organizer credential, made once per publish. Writes are
   * never re-run on a 401 (unlike withOrganizerMeetup's reads): a failed
   * step fails the publish, and Retry resumes from what exists.
   */
  organizer: () => Promise<OrganizerWriter>;
  /** The host's tier now; throws when Discord, Postgres or Meetup cannot answer. */
  tierOf: (meetupMemberId: string) => Promise<HostTier | 'not-a-host'>;
  /** #meetup-bot-alerts, plain (no mentions); fire and forget. */
  alert: (entry: LogEntry) => Promise<unknown>;
  now: () => Date;
}

export type PublishOutcome =
  | { code: 'published'; request: EventRequest }
  | { code: 'failed'; request: EventRequest }
  | { code: 'stale' };

/** Fixed texts: a failure says what exists on Meetup and what to do. */
export const PUBLISH_FAILURES = {
  notAHost:
    'The member is no longer a host (no Guest Host role and no hosted events, ' +
    'or blacklisted). Nothing was created on Meetup.',
  tierUnknown:
    "The host's role could not be checked (Discord, Postgres or Meetup did " +
    'not answer). Nothing was created on Meetup. Retry in a few minutes.',
  noOrganizer:
    'The Meetup organizer login is not usable, so nothing was created on Meetup. Renew it on the dashboard, then Retry.',
  createFailed:
    'Meetup did not create the event. Check the group’s events on Meetup ' +
    'first in case it was created anyway; if it was not, Retry.',
  createdNothing:
    'Meetup returned no event, so nothing is recorded as created. Check the ' +
    'group’s events on Meetup first; if there is none, Retry.',
  rsvp: (url: string): string =>
    `The event was created (${url}) but its RSVP settings were not applied. ` +
    'Retry finishes it without creating a second event, or set the RSVP limits on Meetup by hand.',
  notRecorded: (url: string): string =>
    `The event was created (${url}) but could not be recorded here. ` +
    'Do not Retry: that would create a second event. Set its RSVP limits on Meetup by hand.',
} as const;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

/**
 * Publishes one request on Meetup with the organizer credential. Exactly
 * one caller gets past the compare-and-set; everyone else is 'stale'. The
 * created event's id is stored the moment Meetup returns it, so a retry
 * skips createEvent and only redoes the RSVP steps.
 *
 * Order: claim → tier (prefix) → create → record → close RSVPs and re-apply
 * the limits (closing wipes them) → published. A failure is stored with a
 * fixed text saying what exists, and alerted.
 */
export async function publishRequest(
  deps: PublishDeps,
  id: string,
  seenVersion: number,
  actor: string,
  from: PublishFrom[],
): Promise<PublishOutcome> {
  const claimed = await deps.requests.startPublishing(
    id,
    seenVersion,
    actor,
    from,
    new Date(deps.now().getTime() - STUCK_PUBLISHING_MS),
  );
  if (claimed === undefined) {
    return { code: 'stale' };
  }

  const fail = async (failure: string): Promise<PublishOutcome> => {
    let finished: EventRequest | undefined;
    try {
      finished = await deps.requests.finish(id, { status: 'failed', failure });
    } catch (error: unknown) {
      logger.error(
        `Could not record failed request ${id}: ${errorName(error)}`,
      );
    }
    deps
      .alert({
        title: 'Host event request failed',
        description: failure,
        fields: [
          { name: 'Request', value: `#${id}`, inline: true },
          { name: 'Host', value: claimed.hostName, inline: true },
          { name: 'Title', value: claimed.title },
        ],
      })
      .catch(() => undefined);
    return {
      code: 'failed',
      request: finished ?? { ...claimed, status: 'failed', failure },
    };
  };

  let eventId = claimed.meetupEventId;
  let eventUrl = claimed.eventUrl ?? '';
  let meetup: OrganizerWriter;
  try {
    meetup = await deps.organizer();
  } catch (error: unknown) {
    logger.warn(`Organizer client unavailable: ${errorName(error)}`);
    return fail(PUBLISH_FAILURES.noOrganizer);
  }

  if (eventId === null) {
    let tier: HostTier | 'not-a-host';
    try {
      tier = await deps.tierOf(claimed.meetupMemberId);
    } catch (error: unknown) {
      logger.warn(`Host tier check failed: ${errorName(error)}`);
      return fail(PUBLISH_FAILURES.tierUnknown);
    }
    if (tier === 'not-a-host') {
      return fail(PUBLISH_FAILURES.notAHost);
    }
    let created: CreateEventResponse;
    try {
      created = await createEventWithPhotoFallback(
        meetup,
        createInputFor(claimed, tier),
      );
    } catch (error: unknown) {
      logger.error(`createEvent failed for request ${id}: ${errorName(error)}`);
      return fail(PUBLISH_FAILURES.createFailed);
    }
    const event = created?.createEvent?.event;
    if (!event?.id) {
      return fail(PUBLISH_FAILURES.createdNothing);
    }
    eventId = String(event.id);
    eventUrl = String(event.eventUrl ?? '');
    try {
      await deps.requests.recordCreated(id, eventId, eventUrl);
    } catch (error: unknown) {
      logger.error(
        `Could not record event for request ${id}: ${errorName(error)}`,
      );
      return fail(PUBLISH_FAILURES.notRecorded(eventUrl));
    }
  }

  try {
    await meetup.closeEventRsvps({ eventId });
    // Closing RSVPs wipes the limits, so they are set again after it.
    await meetup.editEvent({
      eventId,
      rsvpSettings: createInputFor(claimed, 'regular').rsvpSettings,
    });
  } catch (error: unknown) {
    logger.error(`RSVP steps failed for request ${id}: ${errorName(error)}`);
    return fail(PUBLISH_FAILURES.rsvp(eventUrl));
  }

  const published = await deps.requests.finish(id, { status: 'published' });
  return {
    code: 'published',
    request: published ?? {
      ...claimed,
      status: 'published',
      meetupEventId: eventId,
      eventUrl,
    },
  };
}

import dayjs from 'dayjs';
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
import { LogEntry, alertText } from '../helpers/discordLogger.js';
import {
  EventRequest,
  PublishFrom,
} from '../repositories/postgresEventRequestRepository.js';
import type { HostTier } from './eligibility.js';
import { createInputFor } from './eventRequest.js';
import { tz } from '../../util/timezone.js';

const logger = new Logger({ name: 'publishRequest' });

/** A 'publishing' request untouched for this long has lost its publisher. */
export const STUCK_PUBLISHING_MS = 10 * 60 * 1000;

/** The organizer client's writes this path makes (GqlMeetupClient has them). */
export interface OrganizerWriter extends EventCreator {
  closeEventRsvps(input: CloseEventRsvpsInput): Promise<unknown>;
  editEvent(input: EditEventInput): Promise<unknown>;
}

/** An event already on Meetup: what a retry adopts instead of creating. */
export interface ExistingEvent {
  id: string;
  eventUrl: string;
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
      version: number,
      eventId: string,
      eventUrl: string,
    ) => Promise<boolean>;
    finish: (
      id: string,
      version: number,
      outcome: { status: 'published' } | { status: 'failed'; failure: string },
    ) => Promise<EventRequest | undefined>;
  };
  /**
   * A client on the organizer credential, made once per publish. Writes are
   * never re-run on a 401 (unlike withOrganizerMeetup's reads): a failed
   * step fails the publish, and Retry resumes from what exists.
   */
  organizer: () => Promise<OrganizerWriter>;
  /**
   * The group's event this request may already have become: hosted by the
   * requester, starting at its time, titled as it would be; upcoming or
   * past (see existingEventFilter). A read, so it may retry on a 401.
   * Throws when Meetup cannot answer.
   */
  findExisting: (request: EventRequest) => Promise<ExistingEvent | undefined>;
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
  startPassed:
    'The event’s start time has passed, so nothing was created on Meetup. ' +
    'Deny the request with a note to the host; they can ask for a new date.',
  startPassedRetry:
    'The event’s start time has passed, so nothing more was done. An earlier ' +
    'attempt may have created it: check the group’s past events on Meetup, ' +
    'then Deny the request with a note to the host.',
  notAHost:
    'The member is no longer a host (no Guest Host role and no hosted events, ' +
    'or blacklisted). Nothing was created on Meetup.',
  tierUnknown:
    "The host's role could not be checked (Discord, Postgres or Meetup did " +
    'not answer). Nothing was created on Meetup. Retry in a few minutes.',
  noOrganizer:
    'The Meetup organizer login is not usable, so nothing was created on ' +
    'Meetup. Renew it on the dashboard, then Retry.',
  noOrganizerCreated: (url: string): string =>
    `The event was created (${url}) but the Meetup organizer login is not ` +
    'usable, so its RSVP settings were not applied. Renew the login on the ' +
    'dashboard, then Retry (it will not create a second event).',
  checkFailed:
    'An earlier attempt may have created the event, and Meetup could not be ' +
    'asked whether it did, so nothing was created. Retry in a few minutes.',
  createFailed:
    'Meetup did not confirm the event. It may have been created anyway: ' +
    'Retry looks for it on Meetup first and will not create a second one.',
  createdNothing:
    'Meetup returned no event. Retry looks for it on Meetup first and will ' +
    'not create a second one.',
  rsvp: (url: string): string =>
    `The event was created (${url}) but its RSVP settings were not applied. ` +
    'Retry finishes it without creating a second event, or set the RSVP limits on Meetup by hand.',
  notRecorded: (url: string): string =>
    `The event was created (${url}) but could not be recorded here. Retry ` +
    'finds it on Meetup and finishes it without creating a second event.',
} as const;

/** True once the request's Pacific start time has come. */
export function startHasPassed(startLocal: string, now: Date): boolean {
  return tz(dayjs(now)).format('YYYY-MM-DDTHH:mm') >= startLocal;
}

/**
 * Whether the queue offers Deny: a waiting request, or a failed one with no
 * event recorded. The deny POST still asks Meetup first for a failed one,
 * since several failures mean an event may exist that was never recorded.
 */
export function canDeny(r: EventRequest): boolean {
  return (
    r.status === 'pending' ||
    (r.status === 'failed' && r.meetupEventId === null)
  );
}

/**
 * Whether the queue offers Mark resolved: a failed request whose event is
 * on Meetup (recorded), once leadership has fixed it there by hand.
 */
export function canResolve(r: EventRequest): boolean {
  return r.status === 'failed' && r.meetupEventId !== null;
}

/**
 * Whether Retry can do anything: not for a failed request with no event
 * recorded whose start has passed, which publishing refuses.
 */
export function canRetry(r: EventRequest, now: Date): boolean {
  return !(
    r.status === 'failed' &&
    r.meetupEventId === null &&
    startHasPassed(r.startLocal, now)
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

/**
 * Publishes one request on Meetup with the organizer credential. Exactly
 * one caller gets past the compare-and-set; everyone else is 'stale'. The
 * created event's id is stored the moment Meetup returns it, so a retry
 * skips createEvent and only redoes the RSVP steps.
 *
 * A retry (from 'failed', or a stuck 'publishing') with no event recorded
 * first asks Meetup for one an earlier attempt may have made (a crash, a
 * timeout or a lost write between createEvent and recording it) and adopts
 * it; it creates only when there is none.
 *
 * Every later write names the version this publisher holds, so a publisher
 * that was overtaken after STUCK_PUBLISHING_MS changes nothing.
 *
 * Order: claim → (start passed: fail) → (retry: look for it) → tier (prefix) → create → record →
 * close RSVPs and re-apply the limits (closing wipes them) → published. A
 * failure is stored with a fixed text saying what exists, and alerted.
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
  const isRetry = from.some((s) => s !== 'pending');
  let version = claimed.version;

  const alertFailure = (failure: string) => {
    deps
      .alert({
        title: 'Host event request failed',
        description: failure,
        fields: [
          { name: 'Request', value: `#${id}`, inline: true },
          {
            name: 'Host',
            value: alertText(claimed.hostName),
            inline: true,
          },
          { name: 'Title', value: alertText(claimed.title) },
        ],
      })
      .catch(() => undefined);
  };

  const fail = async (failure: string): Promise<PublishOutcome> => {
    let finished: EventRequest | undefined;
    try {
      finished = await deps.requests.finish(id, version, {
        status: 'failed',
        failure,
      });
    } catch (error: unknown) {
      logger.error(
        `Could not record failed request ${id}: ${errorName(error)}`,
      );
    }
    alertFailure(failure);
    return {
      code: 'failed',
      request: finished ?? { ...claimed, status: 'failed', failure },
    };
  };

  let eventId = claimed.meetupEventId;
  let eventUrl = claimed.eventUrl ?? '';
  // A request approved or retried after its start would make a past event
  // (or fail, and a retry could not find it among upcoming events). An
  // event already recorded is still finished: it exists either way.
  if (eventId === null && startHasPassed(claimed.startLocal, deps.now())) {
    return fail(
      isRetry
        ? PUBLISH_FAILURES.startPassedRetry
        : PUBLISH_FAILURES.startPassed,
    );
  }

  let meetup: OrganizerWriter;
  try {
    meetup = await deps.organizer();
  } catch (error: unknown) {
    logger.warn(`Organizer client unavailable: ${errorName(error)}`);
    return fail(
      eventId === null
        ? PUBLISH_FAILURES.noOrganizer
        : PUBLISH_FAILURES.noOrganizerCreated(eventUrl),
    );
  }

  /** Stores the event as this request's; false when this publisher lost the row. */
  const record = async (event: ExistingEvent): Promise<boolean> => {
    if (
      !(await deps.requests.recordCreated(
        id,
        version,
        event.id,
        event.eventUrl,
      ))
    ) {
      return false;
    }
    version += 1;
    return true;
  };

  if (eventId === null && isRetry) {
    let existing: ExistingEvent | undefined;
    try {
      existing = await deps.findExisting(claimed);
    } catch (error: unknown) {
      logger.warn(`Existing-event check failed: ${errorName(error)}`);
      return fail(PUBLISH_FAILURES.checkFailed);
    }
    if (existing !== undefined) {
      eventId = existing.id;
      eventUrl = existing.eventUrl;
      let recorded: boolean;
      try {
        recorded = await record(existing);
      } catch (error: unknown) {
        logger.error(
          `Could not record event for request ${id}: ${errorName(error)}`,
        );
        return fail(PUBLISH_FAILURES.notRecorded(eventUrl));
      }
      if (!recorded) {
        return { code: 'stale' };
      }
    }
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
    let recorded: boolean;
    try {
      recorded = await record({ id: eventId, eventUrl });
    } catch (error: unknown) {
      logger.error(
        `Could not record event for request ${id}: ${errorName(error)}`,
      );
      return fail(PUBLISH_FAILURES.notRecorded(eventUrl));
    }
    if (!recorded) {
      // Another publisher took the row over while this one was creating.
      // Its retry looks on Meetup first, so it adopts this event; say so in
      // case both made one.
      deps
        .alert({
          title: 'Host event request: check for a duplicate',
          description:
            `A slow publish of request #${id} created ${eventUrl} after another ` +
            'publish had taken the request over. Check the group’s events for two copies.',
        })
        .catch(() => undefined);
      return { code: 'stale' };
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

  let published: EventRequest | undefined;
  try {
    published = await deps.requests.finish(id, version, {
      status: 'published',
    });
  } catch (error: unknown) {
    // The event is complete on Meetup; only our record lags. A retry after
    // STUCK_PUBLISHING_MS resumes at the RSVP steps and finishes it.
    logger.error(
      `Could not record published request ${id}: ${errorName(error)}`,
    );
    alertFailure(
      `The event is published (${eventUrl}) but could not be marked as published here. ` +
        'Retry it after 10 minutes to finish the record; it will not create a second event.',
    );
  }
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

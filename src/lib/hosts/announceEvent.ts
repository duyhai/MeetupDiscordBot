import { ClientError } from 'graphql-request';
import { Logger } from 'tslog';

import { MeetupPayloadError } from '../client/meetup/payloadErrors.js';
import { LogEntry, alertText } from '../helpers/discordLogger.js';
import { OrganizerTokenUnavailableError } from '../reports/organizerMeetup.js';
import {
  Announcement,
  AnnouncementStatus,
} from '../repositories/postgresEventAnnouncementRepository.js';
import { HostEvent } from './hostEvents.js';

const logger = new Logger({ name: 'hostAnnounce' });

/**
 * How a host's Announce ended:
 * - sent: Meetup sent it now;
 * - already: it went out before (here, or Meetup says so);
 * - in-progress: another click is sending it;
 * - unconfirmed: an earlier try broke without an answer, so it may have
 *   gone out; never tried again from here;
 * - failed: Meetup refused it, nothing went out; the host may try again;
 * - not-yours: not one of the host's own upcoming events.
 */
export type AnnounceCode =
  'sent' | 'already' | 'in-progress' | 'unconfirmed' | 'failed' | 'not-yours';

export interface AnnounceStore {
  claim: (
    meetupEventId: string,
    requestedBy: string,
  ) => Promise<{ claimed: true } | { claimed: false; current: Announcement }>;
  finish: (
    meetupEventId: string,
    status: Exclude<AnnouncementStatus, 'sending'>,
    failure?: string | null,
  ) => Promise<void>;
}

export interface AnnounceDeps {
  announcements: () => Promise<AnnounceStore>;
  /** The host's own upcoming (published) events: Meetup's hostId filter decides. */
  ownUpcoming: (meetupMemberId: string) => Promise<HostEvent[]>;
  /** announceEvent with the organizer credential. */
  announce: (meetupEventId: string) => Promise<void>;
  /** #meetup-bot-alerts, plain. */
  alert: (entry: LogEntry) => Promise<unknown>;
}

/** Meetup's own words for "this was announced before". */
const ALREADY = /already\s+(been\s+)?announced/i;

/**
 * Whether Meetup answered (so nothing went out unless it said so), and its
 * messages. A broken connection, a timeout or an HTTP error without a
 * GraphQL answer is no answer: the announcement may have gone out.
 */
function meetupAnswer(
  error: unknown,
): { answered: true; message: string } | { answered: false; message: string } {
  if (error instanceof MeetupPayloadError) {
    return {
      answered: true,
      message: error.errors.map((e) => `${e.code}: ${e.message}`).join('; '),
    };
  }
  if (error instanceof OrganizerTokenUnavailableError) {
    // Nothing was called.
    return { answered: true, message: error.message };
  }
  if (
    error instanceof ClientError &&
    error.response.status === 200 &&
    (error.response.errors?.length ?? 0) > 0
  ) {
    return {
      answered: true,
      message: (error.response.errors ?? []).map((e) => e.message).join('; '),
    };
  }
  return {
    answered: false,
    message:
      error instanceof ClientError
        ? `HTTP ${String(error.response.status)}`
        : error instanceof Error
          ? error.name
          : 'unknown error',
  };
}

function eventFields(
  event: HostEvent,
  hostName: string,
): NonNullable<LogEntry['fields']> {
  return [
    { name: 'Event', value: alertText(event.title).slice(0, 1000) },
    { name: 'Host', value: alertText(hostName).slice(0, 200), inline: true },
    { name: 'Link', value: event.eventUrl.slice(0, 500), inline: true },
  ];
}

/**
 * Sends Meetup's announcement email for one of the host's own upcoming
 * events, at most once per event: the event's row is claimed before the
 * call (one statement, so of two clicks one claims), and only a refusal
 * Meetup answered (nothing went out) lets it be tried again.
 */
export async function announceHostEvent(
  deps: AnnounceDeps,
  host: { meetupMemberId: string; name: string },
  meetupEventId: string,
): Promise<AnnounceCode> {
  const event = (await deps.ownUpcoming(host.meetupMemberId)).find(
    (e) => e.id === meetupEventId,
  );
  if (event === undefined) {
    return 'not-yours';
  }
  const store = await deps.announcements();
  const claim = await store.claim(meetupEventId, host.meetupMemberId);
  if ('current' in claim) {
    const codes: Record<AnnouncementStatus, AnnounceCode> = {
      sent: 'already',
      sending: 'in-progress',
      unknown: 'unconfirmed',
      // claim takes a failed row, so this is only a row changed in between.
      failed: 'in-progress',
    };
    return codes[claim.current.status];
  }
  const finish = async (
    status: Exclude<AnnouncementStatus, 'sending'>,
    failure: string | null = null,
  ) => {
    // A row left "sending" shows as in progress; it never sends twice.
    await store.finish(meetupEventId, status, failure).catch((e: unknown) => {
      logger.warn(
        `Announcement finish failed: ${e instanceof Error ? e.name : 'Error'}`,
      );
    });
  };
  const alert = (entry: LogEntry) => {
    deps.alert(entry).catch(() => undefined);
  };
  try {
    await deps.announce(meetupEventId);
  } catch (error: unknown) {
    const answer = meetupAnswer(error);
    if (answer.answered && ALREADY.test(answer.message)) {
      await finish('sent');
      return 'already';
    }
    if (answer.answered) {
      await finish('failed', answer.message);
      alert({
        title: 'A host’s announcement was refused',
        description:
          'Meetup refused it, so nothing went out. The host can try again. ' +
          `Meetup said: ${alertText(answer.message).slice(0, 800)}`,
        fields: eventFields(event, host.name),
      });
      return 'failed';
    }
    await finish('unknown', answer.message);
    alert({
      title: 'A host’s announcement may not have gone out',
      description:
        `Meetup did not answer (${answer.message}). It may have sent it; ` +
        'the dashboard will not send it again. Check the event on Meetup and ' +
        'announce it by hand if it did not go out.',
      fields: eventFields(event, host.name),
    });
    return 'unconfirmed';
  }
  await finish('sent');
  alert({
    title: 'A host announced an event',
    fields: eventFields(event, host.name),
  });
  return 'sent';
}

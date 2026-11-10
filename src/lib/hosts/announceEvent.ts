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
 * - already: it went out before (recorded here, or Meetup says so);
 * - in-progress: another click is sending it right now;
 * - unconfirmed: Meetup did not answer; it may or may not have gone out;
 * - failed: Meetup refused it;
 * - not-yours: not one of the host's own upcoming events.
 * Unconfirmed and failed may be tried again: Meetup refuses a second
 * announcement itself, so a retry after a real send comes back "already".
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
  /**
   * announceEvent with the organizer credential. Resolves only when Meetup
   * confirmed the event; a failure to get the credential is an
   * OrganizerTokenUnavailableError (nothing was called).
   */
  announce: (meetupEventId: string) => Promise<void>;
  /** #meetup-bot-alerts, plain. */
  alert: (entry: LogEntry) => Promise<unknown>;
}

/**
 * Meetup's refusal of a second announcement. Unverified against a live
 * refusal: the code, or the whole message being that phrase. Anything else
 * reads as a plain refusal ("failed"), the safe side.
 */
const ALREADY_CODE = /^ALREADY_ANNOUNCED$/i;
const ALREADY_MESSAGE =
  /^(this |the )?event (has |was |is )?already (been )?announced\.?$/i;

type MeetupAnswer =
  | { answered: true; already: boolean; message: string }
  | { answered: false; message: string };

/**
 * Whether Meetup answered, so nothing went out unless it said so. A
 * payload error, a GraphQL error, any 4xx (a refused or expired token, a
 * rate limit) and a credential we could not get are answers. A 5xx, a
 * timeout, a broken connection or an unconfirmed reply are not.
 */
function meetupAnswer(error: unknown): MeetupAnswer {
  if (error instanceof MeetupPayloadError) {
    return {
      answered: true,
      already: error.errors.some(
        (e) =>
          ALREADY_CODE.test(e.code) || ALREADY_MESSAGE.test(e.message.trim()),
      ),
      message: error.errors.map((e) => `${e.code}: ${e.message}`).join('; '),
    };
  }
  if (error instanceof OrganizerTokenUnavailableError) {
    return { answered: true, already: false, message: error.message };
  }
  if (error instanceof ClientError) {
    const { status } = error.response;
    const errors = error.response.errors ?? [];
    if (status === 200 && errors.length > 0) {
      return {
        answered: true,
        already: errors.some((e) => ALREADY_MESSAGE.test(e.message.trim())),
        message: errors.map((e) => e.message).join('; '),
      };
    }
    if (status >= 400 && status < 500) {
      return { answered: true, already: false, message: `HTTP ${status}` };
    }
    return { answered: false, message: `HTTP ${status}` };
  }
  return {
    answered: false,
    message: error instanceof Error ? error.name : 'unknown error',
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
 * events. The event's row is claimed first (one statement), so quick
 * repeat clicks make one call; a row already `sent` sends nothing. Any
 * other ending may be tried again, since Meetup refuses a second
 * announcement itself. `onClaimed` runs once Meetup is about to be called.
 */
export async function announceHostEvent(
  deps: AnnounceDeps,
  host: { meetupMemberId: string; name: string },
  meetupEventId: string,
  hooks: { onClaimed?: () => void } = {},
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
    return claim.current.status === 'sent' ? 'already' : 'in-progress';
  }
  hooks.onClaimed?.();
  const finish = async (
    status: Exclude<AnnouncementStatus, 'sending'>,
    failure: string | null = null,
  ) => {
    // A row left "sending" counts as unconfirmed after a while.
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
    if (answer.answered && answer.already) {
      await finish('sent');
      return 'already';
    }
    if (answer.answered) {
      await finish('failed', answer.message);
      alert({
        title: 'A host’s announcement was refused',
        description:
          'Meetup refused it. The host can try again. ' +
          `Meetup said: ${alertText(answer.message).slice(0, 800)}`,
        fields: eventFields(event, host.name),
      });
      return 'failed';
    }
    await finish('unknown', answer.message);
    alert({
      title: 'A host’s announcement was not confirmed',
      description:
        `Meetup did not confirm it (${answer.message}); it may or may not ` +
        'have gone out. The host can try again: Meetup refuses a second ' +
        'announcement.',
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

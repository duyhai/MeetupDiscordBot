import { ClientError } from 'graphql-request';
import { Logger } from 'tslog';

import { MeetupPayloadError } from '../client/meetup/payloadErrors.js';
import { LogEntry, alertText } from '../helpers/discordLogger.js';
import { OrganizerTokenUnavailableError } from '../reports/organizerMeetup.js';
import {
  AnnounceConfirmation,
  Announcement,
  AnnouncementStatus,
} from '../repositories/postgresEventAnnouncementRepository.js';
import {
  SPACING_MS,
  announceDueAt,
  dueLabel,
  isImmediate,
  pastMeetupCutoff,
  rsvpOpenness,
} from './announceSchedule.js';
import { HostEvent } from './hostEvents.js';

const logger = new Logger({ name: 'hostAnnounce' });

/**
 * How a host's Announce ended:
 * - sent: Meetup sent it now;
 * - scheduled: held until its due time (the work-hours hold or the spacing
 *   rule); the tick sends it then;
 * - already: it went out before (recorded here, or Meetup says so);
 * - in-progress: another click is sending it right now;
 * - unconfirmed: Meetup did not answer; it may or may not have gone out;
 * - failed: Meetup refused it;
 * - not-yours: not one of the host's own upcoming events;
 * - rsvps-closed: RSVPs are not open yet (open them on Meetup first);
 * - rsvps-unknown: Meetup did not say whether RSVPs are open (check by hand);
 * - too-late: within 7 days of the start and created more than 7 days
 *   before it, which Meetup refuses to announce (the page offers
 *   "Recreate and announce" when the event has no other RSVPs).
 * Unconfirmed and failed may be tried again: Meetup refuses a second
 * announcement itself, so a retry after a real send comes back "already".
 */
export type AnnounceCode =
  | 'sent'
  | 'scheduled'
  | 'already'
  | 'in-progress'
  | 'unconfirmed'
  | 'failed'
  | 'not-yours'
  | 'rsvps-closed'
  | 'rsvps-unknown'
  | 'too-late';

/** What the pre-checks read about the event (the organizer credential). */
export interface AnnounceEventDetails {
  id: string;
  title: string;
  eventUrl: string;
  /** ISO. */
  dateTime: string;
  /** ISO, or null when Meetup does not say. */
  createdTime: string | null;
  /** Meetup's rsvpState, or null when it does not say. */
  rsvpState: string | null;
  /** rsvpSettings.rsvpsClosed, or null when Meetup does not say. */
  rsvpsClosed: boolean | null;
  hosts: { id: string; name: string }[];
}

export interface AnnounceStore {
  claim: (
    meetupEventId: string,
    requestedBy: string,
    confirmation: AnnounceConfirmation | null,
  ) => Promise<{ claimed: true } | { claimed: false; current: Announcement }>;
  hold: (
    meetupEventId: string,
    requestedBy: string,
    dueAt: Date,
    confirmation: AnnounceConfirmation | null,
  ) => Promise<{ held: true } | { held: false; current: Announcement }>;
  finish: (
    meetupEventId: string,
    status: Exclude<AnnouncementStatus, 'sending' | 'held' | 'cancelled'>,
    failure?: string | null,
  ) => Promise<void>;
  /** When other announcements go or went out from `since` on (the spacing rule). */
  otherTimes: (exceptEventId: string, since: Date) => Promise<Date[]>;
}

export interface AnnounceDeps {
  announcements: () => Promise<AnnounceStore>;
  /** The host's own upcoming (published) events: Meetup's hostId filter decides. */
  ownUpcoming: (meetupMemberId: string) => Promise<HostEvent[]>;
  /**
   * The event as the pre-checks need it; undefined when Meetup has no such
   * event. Throws when Meetup cannot answer.
   */
  eventDetails: (
    meetupEventId: string,
  ) => Promise<AnnounceEventDetails | undefined>;
  /**
   * announceEvent with the organizer credential. Resolves only when Meetup
   * confirmed the event; a failure to get the credential is an
   * OrganizerTokenUnavailableError (nothing was called).
   */
  announce: (meetupEventId: string) => Promise<void>;
  /** #meetup-bot-alerts, plain. */
  alert: (entry: LogEntry) => Promise<unknown>;
  now: () => Date;
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
    // GraphQL errors are Meetup's answer whether it sent them with 200 or
    // a 4xx; either may say it was already announced.
    if (
      (status === 200 || (status >= 400 && status < 500)) &&
      errors.length > 0
    ) {
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

/** What the alerts say about the event; the title is escaped, never a mention. */
export function announceAlertFields(
  event: { title: string; eventUrl: string },
  hostName: string,
): NonNullable<LogEntry['fields']> {
  return [
    { name: 'Event', value: alertText(event.title).slice(0, 1000) },
    { name: 'Host', value: alertText(hostName).slice(0, 200), inline: true },
    { name: 'Link', value: event.eventUrl.slice(0, 500), inline: true },
  ];
}

export type DeliveryCode =
  'sent' | 'already' | 'failed' | 'unconfirmed' | 'deferred';

export interface DeliveryOptions {
  /** Words the alerts only. */
  how?: 'now' | 'scheduled';
  /**
   * The organizer credential could not be had, so nothing was called:
   * when set, it runs (the tick puts the row back on hold) and the code
   * is 'deferred'; otherwise that is a plain failure.
   */
  onNoToken?: () => Promise<void>;
}

/**
 * The send itself, for a row already claimed as `sending` (by a click or
 * by the tick for a held one): calls Meetup, records how it went, and
 * posts the plain alert. `how` only words the alerts.
 */
export async function deliverAnnouncement(
  deps: Pick<AnnounceDeps, 'announce' | 'alert'>,
  store: Pick<AnnounceStore, 'finish'>,
  event: { id: string; title: string; eventUrl: string },
  hostName: string,
  options: DeliveryOptions = {},
): Promise<DeliveryCode> {
  const how = options.how ?? 'now';
  const finish = async (
    status: Exclude<AnnouncementStatus, 'sending' | 'held' | 'cancelled'>,
    failure: string | null = null,
  ) => {
    // A row left "sending" counts as unconfirmed after a while.
    await store.finish(event.id, status, failure).catch((e: unknown) => {
      logger.warn(
        `Announcement finish failed: ${e instanceof Error ? e.name : 'Error'}`,
      );
    });
  };
  const alert = (entry: LogEntry) => {
    deps.alert(entry).catch(() => undefined);
  };
  const whose = how === 'scheduled' ? 'scheduled announcement' : 'announcement';
  const fields = announceAlertFields(event, hostName);
  try {
    await deps.announce(event.id);
  } catch (error: unknown) {
    if (
      error instanceof OrganizerTokenUnavailableError &&
      options.onNoToken !== undefined
    ) {
      await options.onNoToken();
      return 'deferred';
    }
    const answer = meetupAnswer(error);
    if (answer.answered && answer.already) {
      await finish('sent');
      return 'already';
    }
    if (answer.answered) {
      // Meetup's exact words, so a real "already announced" can be added to
      // the matcher.
      logger.info(
        `Announcement refused, not read as already announced: ${answer.message}`,
      );
      await finish('failed', answer.message);
      alert({
        title: `A host’s ${whose} was refused`,
        description:
          'Meetup refused it. The host can try again. ' +
          `Meetup said: ${alertText(answer.message).slice(0, 800)}`,
        fields,
      });
      return 'failed';
    }
    await finish('unknown', answer.message);
    alert({
      title: `A host’s ${whose} was not confirmed`,
      description:
        `Meetup did not confirm it (${answer.message}); it may or may not ` +
        'have gone out. The host can try again: Meetup refuses a second ' +
        'announcement.',
      fields,
    });
    return 'unconfirmed';
  }
  await finish('sent');
  alert({
    title:
      how === 'scheduled'
        ? 'A host’s scheduled announcement went out'
        : 'A host announced an event',
    fields,
  });
  return 'sent';
}

/** What a row that refused a claim means to the host. */
function codeOf(current: Announcement): AnnounceCode {
  switch (current.status) {
    case 'sent':
      return 'already';
    case 'held':
      return 'scheduled';
    default:
      return 'in-progress';
  }
}

export interface AnnounceOptions {
  /** Runs once Meetup is about to be called. */
  onClaimed?: () => void;
  /** The host's pre-flight confirmation, recorded on the row with the request. */
  confirmation?: AnnounceConfirmation;
}

/**
 * Announces one of the host's own events, known to be theirs (the caller
 * checked, or just created it): the pre-checks, then either a send now or
 * a hold until the schedule's due time. The row is claimed first (one
 * statement), so quick repeat clicks make one call; a row already `sent`
 * or `held` sends nothing. `onClaimed` runs once Meetup is about to be
 * called; the confirmation is kept on the row for leadership to see.
 */
export async function requestAnnouncement(
  deps: AnnounceDeps,
  host: { meetupMemberId: string; name: string },
  event: HostEvent,
  options: AnnounceOptions = {},
): Promise<AnnounceCode> {
  const details = await deps.eventDetails(event.id);
  if (details === undefined) {
    return 'not-yours';
  }
  const openness = rsvpOpenness(details);
  if (openness !== 'open') {
    return openness === 'closed' ? 'rsvps-closed' : 'rsvps-unknown';
  }
  const now = deps.now();
  const start = new Date(details.dateTime);
  if (
    details.createdTime !== null &&
    pastMeetupCutoff(now, start, new Date(details.createdTime))
  ) {
    return 'too-late';
  }
  const store = await deps.announcements();
  const others = await store.otherTimes(
    event.id,
    new Date(now.getTime() - SPACING_MS),
  );
  const due = announceDueAt(now, start, others);
  const confirmation = options.confirmation ?? null;
  if (!isImmediate(due, now)) {
    const held = await store.hold(
      event.id,
      host.meetupMemberId,
      due,
      confirmation,
    );
    if ('current' in held) {
      return codeOf(held.current);
    }
    logger.info(`Announcement of ${event.id} held until ${dueLabel(due)}`);
    return 'scheduled';
  }
  const claim = await store.claim(event.id, host.meetupMemberId, confirmation);
  if ('current' in claim) {
    return codeOf(claim.current);
  }
  options.onClaimed?.();
  const code = await deliverAnnouncement(deps, store, event, host.name);
  // 'deferred' needs onNoToken, which a click never passes.
  return code === 'deferred' ? 'failed' : code;
}

/**
 * Sends Meetup's announcement email for one of the host's own upcoming
 * events, once (requestAnnouncement, after Meetup's hostId filter says the
 * event is theirs).
 */
export async function announceHostEvent(
  deps: AnnounceDeps,
  host: { meetupMemberId: string; name: string },
  meetupEventId: string,
  options: AnnounceOptions = {},
): Promise<AnnounceCode> {
  const event = (await deps.ownUpcoming(host.meetupMemberId)).find(
    (e) => e.id === meetupEventId,
  );
  if (event === undefined) {
    return 'not-yours';
  }
  return requestAnnouncement(deps, host, event, options);
}

export type CancelCode = 'cancelled' | 'not-held' | 'not-yours';

/** Cancels the host's held announcement of their own event. */
export async function cancelHeldAnnouncement(
  deps: Pick<AnnounceDeps, 'ownUpcoming' | 'announcements'>,
  cancel: (meetupEventId: string) => Promise<boolean>,
  host: { meetupMemberId: string },
  meetupEventId: string,
): Promise<CancelCode> {
  const mine = (await deps.ownUpcoming(host.meetupMemberId)).some(
    (e) => e.id === meetupEventId,
  );
  if (!mine) {
    return 'not-yours';
  }
  return (await cancel(meetupEventId)) ? 'cancelled' : 'not-held';
}

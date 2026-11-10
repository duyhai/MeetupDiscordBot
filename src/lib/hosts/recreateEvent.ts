/**
 * "Recreate and announce" (leadership, 2026-11-10): the way out of
 * Meetup's rule that an event within 7 days of its start cannot be
 * announced. Offered only when nobody but the hosts has RSVPed. One click:
 * copy the event (same content, photo, venue, hosts) and create the copy
 * with the organizer credential (no approval: the content is unchanged),
 * announce the copy under the usual hold rules, then cancel the old event
 * (never delete it). The link old→new is recorded. The old event is
 * untouched unless the new one exists and its announcement is on its way.
 */
import dayjs from 'dayjs';
import { Logger } from 'tslog';

import { createEventTemplate } from '../../templates/createEventTemplate.js';
import {
  EventCreator,
  createEventWithPhotoFallback,
} from '../client/meetup/createEventWithPhotoFallback.js';
import { CreateEventInput } from '../client/meetup/types.js';
import { LogEntry, alertText } from '../helpers/discordLogger.js';
import { tz } from '../../util/timezone.js';
import { AnnounceCode } from './announceEvent.js';
import { CopySource, isHostOf } from './eventRequest.js';
import { classifyEventType } from './eventTypes.js';
import { HostEvent } from './hostEvents.js';

const logger = new Logger({ name: 'recreateEvent' });

export type RecreateCode =
  | 'recreated'
  | 'not-yours'
  | 'has-rsvps'
  | 'already-recreated'
  | 'no-source'
  | 'create-failed'
  | 'announce-failed'
  | 'cancel-failed';

export interface RecreateOutcome {
  code: RecreateCode;
  /** The copy, once it exists. */
  newEvent?: HostEvent;
  /** How the copy's announcement went. */
  announce?: AnnounceCode;
}

export type Recreatable =
  | { ok: true }
  | { ok: false; reason: 'not-yours' | 'has-rsvps' | 'already-recreated' };

export interface RecreateDeps {
  /** The host's own upcoming events: Meetup's hostId filter decides. */
  ownUpcoming: (meetupMemberId: string) => Promise<HostEvent[]>;
  /** True when anyone other than the event's hosts has a YES or waitlist RSVP. Throws when Meetup cannot answer. */
  othersRsvped: (meetupEventId: string) => Promise<boolean>;
  /** The event's content to copy (getEventForCopy); undefined when Meetup has none. */
  copySource: (meetupEventId: string) => Promise<CopySource | undefined>;
  /** A client on the organizer credential, made once per recreate. */
  organizer: () => Promise<EventCreator>;
  /** Cancels (never deletes) the event with the organizer credential. */
  cancelEvent: (meetupEventId: string) => Promise<void>;
  recreations: () => Promise<{
    record: (
      oldEventId: string,
      newEventId: string,
      requestedBy: string,
    ) => Promise<boolean>;
    get: (oldEventId: string) => Promise<{ newEventId: string } | undefined>;
  }>;
  /** requestAnnouncement for the new event (the hold rules apply). */
  announce: (
    host: { meetupMemberId: string; name: string },
    event: HostEvent,
  ) => Promise<AnnounceCode>;
  /** #meetup-bot-alerts, plain; fire and forget. */
  alert: (entry: LogEntry) => Promise<unknown>;
  /** The activity log; fire and forget. */
  audit: (entry: LogEntry) => Promise<unknown>;
}

/** The copy's createEvent input: the source as it is, published, RSVPs open. */
export function recreateInput(
  source: CopySource,
  hostIds: string[],
): CreateEventInput {
  const input: CreateEventInput = {
    ...createEventTemplate,
    title: source.title ?? '',
    description: source.description ?? '',
    startDateTime: tz(dayjs(source.dateTime)).format('YYYY-MM-DDTHH:mm'),
    duration: source.duration ?? createEventTemplate.duration,
    eventHosts: hostIds.map(Number),
    rsvpSettings: {
      ...createEventTemplate.rsvpSettings,
      rsvpLimit:
        source.maxTickets ?? createEventTemplate.rsvpSettings.rsvpLimit,
      guestLimit:
        source.guestLimit ?? createEventTemplate.rsvpSettings.guestLimit,
    },
    publishStatus: 'PUBLISHED',
  };
  const photo = Number(source.featuredEventPhoto?.id);
  if (Number.isInteger(photo) && photo > 0) {
    input.featuredPhotoId = photo;
  } else {
    delete input.featuredPhotoId;
  }
  if (source.venue?.id) {
    input.venueId = source.venue.id;
  }
  if (source.howToFindUs?.trim()) {
    input.howToFindUs = source.howToFindUs;
  }
  return input;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

/**
 * Whether the page may offer "Recreate and announce" for this event, and
 * if not, why. Throws when Meetup or Postgres cannot answer.
 */
export async function recreatable(
  deps: Pick<RecreateDeps, 'ownUpcoming' | 'othersRsvped' | 'recreations'>,
  host: { meetupMemberId: string },
  meetupEventId: string,
): Promise<Recreatable> {
  const mine = (await deps.ownUpcoming(host.meetupMemberId)).some(
    (e) => e.id === meetupEventId,
  );
  if (!mine) {
    return { ok: false, reason: 'not-yours' };
  }
  if ((await (await deps.recreations()).get(meetupEventId)) !== undefined) {
    return { ok: false, reason: 'already-recreated' };
  }
  if (await deps.othersRsvped(meetupEventId)) {
    return { ok: false, reason: 'has-rsvps' };
  }
  return { ok: true };
}

/**
 * Order: guard → create the copy → record old→new → announce the copy →
 * cancel the old. A failure before the copy exists leaves the old event
 * untouched. A copy whose announcement did not go out (refused or
 * unconfirmed) also leaves the old event in place: both exist, and the
 * alert says so, so leadership can sort it out by hand.
 */
export async function recreateAndAnnounce(
  deps: RecreateDeps,
  host: { meetupMemberId: string; name: string },
  meetupEventId: string,
): Promise<RecreateOutcome> {
  const old = (await deps.ownUpcoming(host.meetupMemberId)).find(
    (e) => e.id === meetupEventId,
  );
  if (old === undefined) {
    return { code: 'not-yours' };
  }
  const recreations = await deps.recreations();
  if ((await recreations.get(old.id)) !== undefined) {
    return { code: 'already-recreated' };
  }
  if (await deps.othersRsvped(old.id)) {
    return { code: 'has-rsvps' };
  }
  const source = await deps.copySource(old.id);
  if (source === undefined || !isHostOf(source, host.meetupMemberId)) {
    return { code: 'no-source' };
  }
  const hostIds = (source.eventHosts ?? []).flatMap((h) => {
    return h?.member?.id ? [String(h.member.id)] : [];
  });
  const fields = (event: { title: string; eventUrl: string }) => [
    { name: 'Event', value: alertText(event.title).slice(0, 1000) },
    { name: 'Host', value: alertText(host.name).slice(0, 200), inline: true },
    { name: 'Old', value: old.eventUrl.slice(0, 500), inline: true },
    { name: 'New', value: event.eventUrl.slice(0, 500), inline: true },
  ];
  const tell = (entry: LogEntry) => {
    deps.alert(entry).catch(() => undefined);
  };

  let created: { id: string; eventUrl: string } | null | undefined;
  try {
    const meetup = await deps.organizer();
    created = (
      await createEventWithPhotoFallback(meetup, recreateInput(source, hostIds))
    ).createEvent?.event;
  } catch (error: unknown) {
    logger.error(`Recreate of ${old.id} failed to create: ${errorName(error)}`);
    tell({
      title: 'A host’s recreate-and-announce failed',
      description:
        'The copy could not be created on Meetup, so the old event is untouched. ' +
        'The host can try again.',
      fields: fields({ title: old.title, eventUrl: '' }).slice(0, 3),
    });
    return { code: 'create-failed' };
  }
  if (!created?.id) {
    tell({
      title: 'A host’s recreate-and-announce failed',
      description:
        'Meetup returned no event for the copy, so the old event is untouched. ' +
        'Check the group’s upcoming events for a copy before the host tries again.',
      fields: fields({ title: old.title, eventUrl: '' }).slice(0, 3),
    });
    return { code: 'create-failed' };
  }
  const newEvent: HostEvent = {
    id: String(created.id),
    title: source.title ?? old.title,
    dateTime: source.dateTime,
    eventUrl: String(created.eventUrl ?? ''),
    type: classifyEventType(source.title ?? old.title),
    hosts: old.hosts,
  };
  try {
    await recreations.record(old.id, newEvent.id, host.meetupMemberId);
  } catch (error: unknown) {
    // The copy exists either way; the link is for the page and the alert.
    logger.error(`Recreation record failed: ${errorName(error)}`);
  }
  deps
    .audit({
      title: 'Host recreated an event to announce it',
      fields: fields(newEvent),
    })
    .catch(() => undefined);

  const announce = await deps.announce(host, newEvent);
  if (!['sent', 'scheduled', 'already'].includes(announce)) {
    tell({
      title: 'A host’s recreated event was not announced',
      description:
        `The copy was created but its announcement ended "${announce}", so the ` +
        'old event was NOT cancelled: both are on Meetup. Announce the copy and ' +
        'cancel the old one by hand, or the host can try announcing again.',
      fields: fields(newEvent),
    });
    return { code: 'announce-failed', newEvent, announce };
  }
  try {
    await deps.cancelEvent(old.id);
  } catch (error: unknown) {
    logger.error(`Cancel of ${old.id} failed: ${errorName(error)}`);
    tell({
      title: 'A host’s old event could not be cancelled',
      description:
        'The copy was created and its announcement is on its way, but Meetup ' +
        'did not cancel the old event. Cancel it by hand.',
      fields: fields(newEvent),
    });
    return { code: 'cancel-failed', newEvent, announce };
  }
  tell({
    title: 'A host recreated an event to announce it',
    description:
      'The old event was within 7 days of its start, so Meetup would not announce ' +
      `it. The copy is ${announce === 'scheduled' ? 'scheduled to be announced' : 'announced'}; the old event is cancelled.`,
    fields: fields(newEvent),
  });
  return { code: 'recreated', newEvent, announce };
}

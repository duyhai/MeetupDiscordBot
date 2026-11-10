/**
 * "Recreate and announce" (leadership, 2026-11-10): the way out of
 * Meetup's rule that an event within 7 days of its start cannot be
 * announced. Offered only when nobody but the hosts has RSVPed. One click:
 * copy the event (same content, photo, venue, hosts) and create the copy
 * with the organizer credential (no approval: the content is unchanged),
 * announce the copy under the usual hold rules, then cancel the old event
 * (never delete it). The link old→new is claimed before the copy is made,
 * so two clicks make one copy, and recorded. The old event is untouched
 * unless the new one exists and its announcement is on its way.
 */
import dayjs from 'dayjs';
import { Logger } from 'tslog';

import {
  EventCreator,
  createEventWithPhotoFallback,
} from '../client/meetup/createEventWithPhotoFallback.js';
import { CreateEventInput } from '../client/meetup/types.js';
import { LogEntry, alertText } from '../helpers/discordLogger.js';
import { tz } from '../../util/timezone.js';
import { AnnounceCode } from './announceEvent.js';
import {
  CopySource,
  buildCreateInput,
  copyDefaults,
  copySettings,
  isHostOf,
} from './eventRequest.js';
import { classifyEventType } from './eventTypes.js';
import { HostEvent, pacificDay } from './hostEvents.js';

const logger = new Logger({ name: 'recreateEvent' });

export type RecreateCode =
  | 'recreated'
  | 'recreated-scheduled'
  | 'recreated-old-kept'
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
  /** Meetup refused the featured photo, so the copy has none. */
  photoDropped?: boolean;
}

export type Recreatable =
  | { ok: true }
  | { ok: false; reason: 'not-yours' | 'has-rsvps' | 'already-recreated' };

export interface RecreationStore {
  /**
   * Takes the old event for a recreation now: true once; false while
   * another recreation of it is under way or done (a pending claim older
   * than its stale time may be taken over).
   */
  claim: (oldEventId: string, requestedBy: string) => Promise<boolean>;
  /** Fills in the copy once Meetup returns it. */
  fill: (oldEventId: string, newEventId: string) => Promise<void>;
  /** Drops a pending claim whose copy was never made. */
  release: (oldEventId: string) => Promise<void>;
  get: (
    oldEventId: string,
  ) => Promise<{ newEventId: string | null } | undefined>;
}

export interface RecreateDeps {
  /** The host's own upcoming events: Meetup's hostId filter decides. */
  ownUpcoming: (meetupMemberId: string) => Promise<HostEvent[]>;
  /** True when anyone other than the event's hosts has a YES or waitlist RSVP. Throws when Meetup cannot answer. */
  othersRsvped: (meetupEventId: string) => Promise<boolean>;
  /** The event's content to copy (getEventForCopy); undefined when Meetup has none. */
  copySource: (meetupEventId: string) => Promise<CopySource | undefined>;
  /** A client on the organizer credential, made once per recreate. */
  organizer: () => Promise<EventCreator>;
  /**
   * Cancels (never deletes) the event with the organizer credential.
   * Undefined while ANNOUNCE_RECREATE_CANCEL is off: the old event is left
   * for leadership to cancel by hand, and the alert says so.
   */
  cancelEvent: ((meetupEventId: string) => Promise<void>) | undefined;
  recreations: () => Promise<RecreationStore>;
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

/**
 * The copy's createEvent input: the source's settings as the copy path
 * validates them (copySettings: limits, venue, directions, duration), the
 * title verbatim (its prefix stays), every source host, published.
 */
export function recreateInput(
  source: CopySource,
  hostIds: string[],
): CreateEventInput {
  const { duration } = copyDefaults(source);
  return buildCreateInput({
    ...copySettings(source, duration),
    title: source.title ?? '',
    startLocal: tz(dayjs(source.dateTime)).format('YYYY-MM-DDTHH:mm'),
    hostIds,
  });
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
 * Order: guard → claim old→new → create the copy → fill the claim →
 * announce the copy → cancel the old (when the flag allows). A failure
 * before the copy exists releases the claim and leaves the old event
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
  if (await deps.othersRsvped(old.id)) {
    return { code: 'has-rsvps' };
  }
  const recreations = await deps.recreations();
  // Claimed before the slow part: a second click (or the page's "slow"
  // redirect and a retry) finds the claim and makes no second copy.
  if (!(await recreations.claim(old.id, host.meetupMemberId))) {
    return { code: 'already-recreated' };
  }
  const release = async () => {
    await recreations.release(old.id).catch((error: unknown) => {
      logger.error(`Recreation release failed: ${errorName(error)}`);
    });
  };
  let source: CopySource | undefined;
  try {
    source = await deps.copySource(old.id);
  } catch (error: unknown) {
    await release();
    throw error;
  }
  if (source === undefined || !isHostOf(source, host.meetupMemberId)) {
    await release();
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
  let photoDropped = false;
  try {
    const meetup = await deps.organizer();
    created = (
      await createEventWithPhotoFallback(
        meetup,
        recreateInput(source, hostIds),
        {
          onPhotoDropped: () => {
            photoDropped = true;
          },
        },
      )
    ).createEvent?.event;
  } catch (error: unknown) {
    logger.error(`Recreate of ${old.id} failed to create: ${errorName(error)}`);
    await release();
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
    await release();
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
    await recreations.fill(old.id, newEvent.id);
  } catch (error: unknown) {
    // The copy exists either way; the link is for the page and the alert.
    logger.error(`Recreation record failed: ${errorName(error)}`);
  }
  const photoNote = photoDropped
    ? ' Meetup refused the featured photo, so the copy has none: set one by hand.'
    : '';
  deps
    .audit({
      title: 'Host recreated an event to announce it',
      description: `Starts ${pacificDay(newEvent.dateTime)}.${photoNote}`,
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
        `cancel the old one by hand.${photoNote}`,
      fields: fields(newEvent),
    });
    return { code: 'announce-failed', newEvent, announce, photoDropped };
  }
  const copyStatus =
    announce === 'scheduled'
      ? 'The copy’s announcement is scheduled (the host’s page shows when).'
      : 'The copy is announced.';
  if (deps.cancelEvent === undefined) {
    tell({
      title: 'A host recreated an event: cancel the old one by hand',
      description:
        `${copyStatus} Cancelling on Meetup from here is switched off ` +
        '(ANNOUNCE_RECREATE_CANCEL), so the old event is still live: cancel it ' +
        `by hand.${photoNote}`,
      fields: fields(newEvent),
    });
    return { code: 'recreated-old-kept', newEvent, announce, photoDropped };
  }
  try {
    await deps.cancelEvent(old.id);
  } catch (error: unknown) {
    logger.error(`Cancel of ${old.id} failed: ${errorName(error)}`);
    tell({
      title: 'A host’s old event could not be cancelled',
      description: `${copyStatus} Meetup did not cancel the old event: cancel it by hand.${photoNote}`,
      fields: fields(newEvent),
    });
    return { code: 'cancel-failed', newEvent, announce, photoDropped };
  }
  tell({
    title: 'A host recreated an event to announce it',
    description:
      'The old event was within 7 days of its start, so Meetup would not announce ' +
      `it. ${copyStatus} The old event is cancelled.${photoNote}`,
    fields: fields(newEvent),
  });
  return {
    code: announce === 'scheduled' ? 'recreated-scheduled' : 'recreated',
    newEvent,
    announce,
    photoDropped,
  };
}

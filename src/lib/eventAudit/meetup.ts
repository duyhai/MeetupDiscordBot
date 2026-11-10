import dayjs from 'dayjs';
import { Client } from 'discord.js';
import { Logger } from 'tslog';

import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { getPaginatedData } from '../client/meetup/paginationHelper.js';
import { AuditEventNode, GroupEventFilter } from '../client/meetup/types.js';
import {
  OrganizerMeetupDeps,
  defaultOrganizerMeetupDeps,
  withOrganizerMeetup,
} from '../reports/organizerMeetup.js';
import { EventHost, EventObservation } from './types.js';

const logger = new Logger({ name: 'eventAuditMeetup' });

export const TITLE_MAX = 300;
export const HOST_NAME_MAX = 100;
/** How far back the PAST listing reaches, so an event that just happened is seen leaving the upcoming list. */
export const RECENT_PAST_DAYS = 2;

/** A Meetup event page URL; the only event link ever stored or rendered. */
export const MEETUP_EVENT_URL =
  /^https:\/\/www\.meetup\.com\/[A-Za-z0-9_-]+\/events\/[0-9]+\/?$/;

const DIGITS = /^[0-9]{1,20}$/;
const DURATION = /^P[0-9A-Z.]{1,30}$/;
const STATUSES = new Set([
  'ACTIVE',
  'AUTOSCHED',
  'AUTOSCHED_CANCELLED',
  'AUTOSCHED_DRAFT',
  'AUTOSCHED_FINISHED',
  'BLOCKED',
  'CANCELLED',
  'CANCELLED_PERM',
  'DRAFT',
  'PAST',
  'PENDING',
  'PROPOSED',
  'TEMPLATE',
]);

function digits(value: unknown): string | null {
  return typeof value === 'string' && DIGITS.test(value) ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string'
    ? Array.from(value.trim()).slice(0, max).join('')
    : '';
}

function hosts(value: unknown): EventHost[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry: unknown) => {
    const member = (entry as { member?: unknown } | null)?.member as
      { id?: unknown; name?: unknown } | null | undefined;
    const id = digits(member?.id);
    return id === null ? [] : [{ id, name: text(member?.name, HOST_NAME_MAX) }];
  });
}

/**
 * A listing or single-event node as an observation, or undefined when it
 * has no usable id or start (dropped with a process log line). Member
 * text is kept verbatim but bounded: escaping is the page's and the
 * alert's job. Unknown or malformed optional fields are null.
 */
export function toObservation(node: unknown): EventObservation | undefined {
  if (typeof node !== 'object' || node === null) {
    return undefined;
  }
  const n = node as AuditEventNode;
  const eventId = digits(n.id);
  const start = typeof n.dateTime === 'string' ? dayjs(n.dateTime) : undefined;
  if (eventId === null || start === undefined || !start.isValid()) {
    logger.warn(
      'Event audit: a listing node without a usable id or start was dropped',
    );
    return undefined;
  }
  const status =
    typeof n.status === 'string' && STATUSES.has(n.status)
      ? n.status
      : 'UNKNOWN';
  const duration =
    typeof n.duration === 'string' && DURATION.test(n.duration)
      ? n.duration
      : null;
  const eventUrl =
    typeof n.eventUrl === 'string' && MEETUP_EVENT_URL.test(n.eventUrl)
      ? n.eventUrl
      : null;
  const rsvpsClosed = n.rsvpSettings?.rsvpsClosed;
  const created =
    typeof n.createdTime === 'string' ? dayjs(n.createdTime) : undefined;
  return {
    eventId,
    title: text(n.title, TITLE_MAX),
    status,
    startAt: start.toDate(),
    createdAt: created?.isValid() ? created.toDate() : null,
    duration,
    eventUrl,
    venueId: digits(n.venue?.id),
    photoId: digits(n.featuredEventPhoto?.id),
    hosts: hosts(n.eventHosts),
    rsvpYes: count(n.yes?.totalCount),
    waitlist: count(n.waitlist?.totalCount),
    rsvpsClosed: typeof rsvpsClosed === 'boolean' ? rsvpsClosed : null,
    lastEditedAt: null,
  };
}

export interface AuditMeetupReader {
  /** Upcoming (ACTIVE, every page) plus PAST within RECENT_PAST_DAYS; one per id, upcoming wins. */
  listEvents(now: Date): Promise<EventObservation[]>;
  /** The event, or null when Meetup has no such event. Throws on an outage. */
  getEvent(eventId: string): Promise<EventObservation | null>;
}

type AuditClient = Pick<
  GqlMeetupClient,
  'getGroupEventsForAudit' | 'getEventForAudit'
>;

export function gqlAuditReader(meetup: AuditClient): AuditMeetupReader {
  const listPages = (filter: GroupEventFilter) =>
    getPaginatedData<AuditEventNode>((pagination) =>
      meetup.getGroupEventsForAudit(pagination, filter),
    );
  return {
    async listEvents(now) {
      const upcoming = await listPages({ status: ['ACTIVE'] });
      const past = await listPages({
        status: ['PAST'],
        afterDateTime: dayjs(now)
          .subtract(RECENT_PAST_DAYS, 'day')
          .toISOString(),
        beforeDateTime: now.toISOString(),
      });
      const byId = new Map<string, EventObservation>();
      for (const node of [...upcoming, ...past]) {
        const observation = toObservation(node);
        if (observation && !byId.has(observation.eventId)) {
          byId.set(observation.eventId, observation);
        }
      }
      return [...byId.values()];
    },
    async getEvent(eventId) {
      const node = await meetup.getEventForAudit(eventId);
      if (node === null) {
        return null;
      }
      const observation = toObservation(node);
      // A node Meetup returned but this code cannot read is not "gone".
      if (observation === undefined) {
        throw new Error('Event audit: unreadable event node');
      }
      return observation;
    },
  };
}

export type ReadMeetup = <T>(
  fn: (reader: AuditMeetupReader) => Promise<T>,
) => Promise<T>;

/**
 * Production reads: the organizer credential through withOrganizerMeetup
 * (one refresh and retry on a 401; fn must only read Meetup).
 */
export function organizerReadMeetup(
  getClient: () => Client | undefined,
  organizer: OrganizerMeetupDeps = defaultOrganizerMeetupDeps,
): ReadMeetup {
  return (fn) =>
    withOrganizerMeetup(
      getClient(),
      (meetup) => fn(gqlAuditReader(meetup)),
      organizer,
    );
}

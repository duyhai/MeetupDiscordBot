/**
 * The group snapshot's view of Meetup nodes: validated the way the event
 * audit validates its own (digit ids, a parsable start, Meetup event URLs
 * only, bounded titles). Ids and statuses only; no names ever reach here.
 */
import dayjs from 'dayjs';

import { EventStatus } from '../client/meetup/types.js';
import { MEETUP_EVENT_URL, TITLE_MAX } from '../eventAudit/meetup.js';

export interface SnapshotEvent {
  eventId: string;
  title: string;
  dateTime: Date;
  eventUrl: string | null;
  status: EventStatus | 'UNKNOWN';
  /** Meetup member ids. */
  hostIds: string[];
  /** Meetup's YES + ATTENDED total at listing time. */
  yesCount: number | null;
  waitlistCount: number | null;
}

export const SNAPSHOT_RSVP_STATUSES = ['YES', 'WAITLIST', 'ATTENDED'] as const;
export type SnapshotRsvpStatus = (typeof SNAPSHOT_RSVP_STATUSES)[number];

export interface SnapshotRsvp {
  memberId: string;
  status: SnapshotRsvpStatus;
}

const DIGITS = /^[0-9]{1,20}$/;
const STATUSES: ReadonlySet<string> = new Set<EventStatus>([
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

function digits(value: unknown): string | undefined {
  return typeof value === 'string' && DIGITS.test(value) ? value : undefined;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function title(value: unknown): string {
  return typeof value === 'string'
    ? Array.from(value.trim()).slice(0, TITLE_MAX).join('')
    : '';
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** A listing node as a snapshot event, or undefined without a usable id or start. */
export function toSnapshotEvent(node: unknown): SnapshotEvent | undefined {
  const n = node;
  const eventId = digits(field(n, 'id'));
  const rawStart = field(n, 'dateTime');
  const start = typeof rawStart === 'string' ? dayjs(rawStart) : undefined;
  if (eventId === undefined || start === undefined || !start.isValid()) {
    return undefined;
  }
  const status = field(n, 'status');
  const url = field(n, 'eventUrl');
  const hosts = field(n, 'eventHosts');
  return {
    eventId,
    title: title(field(n, 'title')),
    dateTime: start.toDate(),
    eventUrl:
      typeof url === 'string' && MEETUP_EVENT_URL.test(url) ? url : null,
    status:
      typeof status === 'string' && STATUSES.has(status)
        ? (status as EventStatus)
        : 'UNKNOWN',
    hostIds: Array.isArray(hosts)
      ? hosts.flatMap((host: unknown) => {
          const id = digits(field(field(host, 'member'), 'id'));
          return id === undefined ? [] : [id];
        })
      : [],
    yesCount: count(field(field(n, 'attendance'), 'totalCount')),
    waitlistCount: count(field(field(n, 'waitlist'), 'totalCount')),
  };
}

/** An RSVP node, or undefined for another status or an unusable member. */
export function toSnapshotRsvp(node: unknown): SnapshotRsvp | undefined {
  const status = field(node, 'status');
  const memberId = digits(field(field(node, 'member'), 'id'));
  if (
    memberId === undefined ||
    typeof status !== 'string' ||
    !(SNAPSHOT_RSVP_STATUSES as readonly string[]).includes(status)
  ) {
    return undefined;
  }
  return { memberId, status: status as SnapshotRsvpStatus };
}

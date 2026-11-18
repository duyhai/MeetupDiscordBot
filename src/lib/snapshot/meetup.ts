/**
 * The group snapshot's view of Meetup nodes: validated the way the event
 * audit validates its own (digit ids, a parsable start, Meetup event URLs
 * only, bounded titles). Ids and statuses only, except hosts' names (shown
 * on every public event page), which the leaderboard keeps apart.
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
  /**
   * Each host's Meetup name by id, for meetup_host_names (the leaderboard).
   * Optional: older callers and tests build events without it.
   */
  hostNames?: Record<string, string>;
  /** Meetup's YES + ATTENDED total at listing time. */
  yesCount: number | null;
  waitlistCount: number | null;
  /**
   * Where it happened, coarsely: the venue rounded to a 0.01° grid (about
   * 1 km) and its city. Null for an online event or a venue without real
   * coordinates. Optional: older callers and tests build events without it.
   */
  place?: EventPlace | null;
}

/** A venue as the snapshot keeps it: grid indices (degrees × 100) and city. */
export interface EventPlace {
  latE2: number;
  lonE2: number;
  city: string | null;
}

/** Degrees per grid step: 0.01° is about 1.1 km north-south. */
export const PLACE_GRID = 0.01;
const CITY_MAX = 80;

export const SNAPSHOT_RSVP_STATUSES = ['YES', 'WAITLIST', 'ATTENDED'] as const;
export type SnapshotRsvpStatus = (typeof SNAPSHOT_RSVP_STATUSES)[number];

export interface SnapshotRsvp {
  memberId: string;
  status: SnapshotRsvpStatus;
}

const DIGITS = /^[0-9]{1,20}$/;
/** Longer Meetup names are cut, as titles are. */
export const HOST_NAME_MAX = 100;
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

/** A trimmed, bounded name without control characters; undefined when there is none. */
function hostName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Control characters out first: Postgres refuses U+0000 in text, which
  // would fail the whole listing's write.
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const name = Array.from(clean).slice(0, HOST_NAME_MAX).join('');
  return name === '' ? undefined : name;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The venue as a grid cell, or null: online events (isOnline, or the ONLINE
 * type), no venue, coordinates out of range, and Meetup's 0,0 placeholder
 * are left out. Exact coordinates never leave this function.
 */
export function toPlace(node: unknown): EventPlace | null {
  if (
    field(node, 'isOnline') === true ||
    field(node, 'eventType') === 'ONLINE'
  ) {
    return null;
  }
  const venue = field(node, 'venue');
  const lat = finite(field(venue, 'lat'));
  const lon = finite(field(venue, 'lon'));
  if (
    lat === undefined ||
    lon === undefined ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    (Math.abs(lat) < 0.5 && Math.abs(lon) < 0.5)
  ) {
    return null;
  }
  const rawCity = field(venue, 'city');
  const city =
    typeof rawCity === 'string'
      ? Array.from(rawCity.replace(/[\u0000-\u001f\u007f]/g, '').trim())
          .slice(0, CITY_MAX)
          .join('')
      : '';
  return {
    latE2: Math.round(lat / PLACE_GRID),
    lonE2: Math.round(lon / PLACE_GRID),
    city: city === '' ? null : city,
  };
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
  const hostNames: Record<string, string> = {};
  if (Array.isArray(hosts)) {
    hosts.forEach((host: unknown) => {
      const member = field(host, 'member');
      const id = digits(field(member, 'id'));
      const name = hostName(field(member, 'name'));
      if (id !== undefined && name !== undefined) {
        hostNames[id] = name;
      }
    });
  }
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
    hostNames,
    yesCount: count(field(field(n, 'attendance'), 'totalCount')),
    waitlistCount: count(field(field(n, 'waitlist'), 'totalCount')),
    place: toPlace(n),
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

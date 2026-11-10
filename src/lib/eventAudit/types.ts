/**
 * The audit trail's data: what one Meetup read of an event looks like
 * (EventObservation), what is stored (EventSnapshot) and what a change row
 * records (EventChange). Pure types and the status rule; no I/O.
 */

export const EVENT_CHANGE_KINDS = [
  'created',
  'cancelled',
  'deleted',
  'host_changed',
  'start_moved',
  'title_changed',
  'rsvp_drop',
  'rsvps_closed',
] as const;
export type EventChangeKind = (typeof EVENT_CHANGE_KINDS)[number];

export const isEventChangeKind = (value: unknown): value is EventChangeKind =>
  typeof value === 'string' &&
  (EVENT_CHANGE_KINDS as readonly string[]).includes(value);

/** Meetup statuses that mean the event was cancelled (not deleted). */
export const CANCELLED_STATUSES: ReadonlySet<string> = new Set([
  'CANCELLED',
  'CANCELLED_PERM',
  'AUTOSCHED_CANCELLED',
]);

export const isCancelledStatus = (status: string): boolean =>
  CANCELLED_STATUSES.has(status);

export interface EventHost {
  id: string;
  name: string;
}

/** One read of one event, validated (see meetup.ts); the stored shape minus ids and time. */
export interface EventObservation {
  eventId: string;
  title: string;
  status: string;
  startAt: Date;
  /** ISO 8601 duration as Meetup sends it, or null. */
  duration: string | null;
  /** A Meetup event URL (MEETUP_EVENT_URL), or null. */
  eventUrl: string | null;
  venueId: string | null;
  photoId: string | null;
  hosts: EventHost[];
  rsvpYes: number | null;
  waitlist: number | null;
  rsvpsClosed: boolean | null;
  /** Never set in v1: Meetup's API does not expose it. */
  lastEditedAt: Date | null;
}

export interface EventSnapshot extends EventObservation {
  id: number;
  runId: number;
  takenAt: Date;
}

/** A change as the diff produces it, before it has a row. */
export interface NewEventChange {
  eventId: string;
  kind: EventChangeKind;
  /** JSON (dates as ISO strings); null for `created`. */
  oldValue: unknown;
  /** JSON; null for `deleted`. */
  newValue: unknown;
  /** The event as last seen, so the row stands on its own. */
  title: string;
  startAt: Date;
  eventUrl: string | null;
  /** The likely actors: the hosts at the time (old and new for a host change). */
  hosts: EventHost[];
  rsvpYes: number | null;
  waitlist: number | null;
}

export interface EventChange extends NewEventChange {
  id: number;
  runId: number;
  detectedAt: Date;
  /** Never set in v1. */
  actor: string | null;
  alertedAt: Date | null;
}

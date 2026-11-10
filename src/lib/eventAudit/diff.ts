import {
  EventHost,
  EventObservation,
  NewEventChange,
  isCancelledStatus,
} from './types.js';

/** An RSVP drop is at least this many people, or RSVP_DROP_FRACTION of the previous count. */
export const RSVP_DROP_MIN = 5;
export const RSVP_DROP_FRACTION = 0.25;
/** Below this many going, one person leaving is not a drop worth a row. */
export const RSVP_DROP_MIN_BASE = 4;
/** A drop is never fewer people than this. */
export const RSVP_DROP_MIN_PEOPLE = 2;

/** Between consecutive snapshots only; unknown counts never count as a drop. */
export function isRsvpDrop(prev: number | null, next: number | null): boolean {
  if (prev === null || next === null || prev < RSVP_DROP_MIN_BASE) {
    return false;
  }
  const drop = prev - next;
  return (
    drop >= RSVP_DROP_MIN_PEOPLE &&
    (drop >= RSVP_DROP_MIN || drop >= prev * RSVP_DROP_FRACTION)
  );
}

const hostIds = (hosts: EventHost[]) => [...hosts.map((h) => h.id)].sort();

const sameHosts = (a: EventHost[], b: EventHost[]) =>
  hostIds(a).join(',') === hostIds(b).join(',');

/** Old hosts first, then the new ones not already there (by id). */
function unionHosts(a: EventHost[], b: EventHost[]): EventHost[] {
  const seen = new Set(a.map((h) => h.id));
  return [...a, ...b.filter((h) => !seen.has(h.id))];
}

/** The parts of a change that describe the event as last seen. */
function lastSeen(
  o: EventObservation,
): Pick<
  NewEventChange,
  | 'eventId'
  | 'title'
  | 'startAt'
  | 'eventUrl'
  | 'hosts'
  | 'rsvpYes'
  | 'waitlist'
> {
  return {
    eventId: o.eventId,
    title: o.title,
    startAt: o.startAt,
    eventUrl: o.eventUrl,
    hosts: o.hosts,
    rsvpYes: o.rsvpYes,
    waitlist: o.waitlist,
  };
}

const isOver = (o: EventObservation, now: Date) =>
  o.status === 'PAST' ||
  isCancelledStatus(o.status) ||
  o.startAt.getTime() <= now.getTime();

/**
 * The changes between an event's previous snapshot and this read, in the
 * spec's table order. With no previous snapshot the event is `created`,
 * except on the baseline run (the first run ever) or when it has already
 * started or ended (a first sight of an old event is not a creation). A
 * cancelled event stays cancelled: nothing further is recorded for it. An
 * RSVP drop on an event that is over is attrition, not a drop. A read with
 * no hosts after one with hosts is treated as transient (Meetup events
 * always have a host): no host change is recorded for it.
 */
export function diffEvent(
  previous: EventObservation | undefined,
  next: EventObservation,
  options: { baseline: boolean; now: Date },
): NewEventChange[] {
  if (previous === undefined) {
    if (options.baseline || isOver(next, options.now)) {
      return [];
    }
    return [
      {
        ...lastSeen(next),
        kind: 'created',
        oldValue: null,
        newValue: {
          title: next.title,
          startAt: next.startAt.toISOString(),
          hosts: next.hosts,
        },
      },
    ];
  }
  if (isCancelledStatus(previous.status)) {
    return [];
  }
  const changes: NewEventChange[] = [];
  const base = lastSeen(next);
  if (isCancelledStatus(next.status)) {
    changes.push({
      ...base,
      kind: 'cancelled',
      oldValue: { status: previous.status },
      newValue: { status: next.status },
    });
  }
  if (
    !sameHosts(previous.hosts, next.hosts) &&
    !(next.hosts.length === 0 && previous.hosts.length > 0)
  ) {
    changes.push({
      ...base,
      kind: 'host_changed',
      oldValue: { hosts: previous.hosts },
      newValue: { hosts: next.hosts },
      hosts: unionHosts(previous.hosts, next.hosts),
    });
  }
  if (previous.startAt.getTime() !== next.startAt.getTime()) {
    changes.push({
      ...base,
      kind: 'start_moved',
      oldValue: { startAt: previous.startAt.toISOString() },
      newValue: { startAt: next.startAt.toISOString() },
    });
  }
  if (previous.title !== next.title) {
    changes.push({
      ...base,
      kind: 'title_changed',
      oldValue: { title: previous.title },
      newValue: { title: next.title },
    });
  }
  if (
    !isOver(next, options.now) &&
    isRsvpDrop(previous.rsvpYes, next.rsvpYes)
  ) {
    changes.push({
      ...base,
      kind: 'rsvp_drop',
      oldValue: { rsvpYes: previous.rsvpYes, waitlist: previous.waitlist },
      newValue: { rsvpYes: next.rsvpYes, waitlist: next.waitlist },
    });
  }
  if (previous.rsvpsClosed === false && next.rsvpsClosed === true) {
    changes.push({
      ...base,
      kind: 'rsvps_closed',
      oldValue: { rsvpsClosed: false },
      newValue: { rsvpsClosed: true },
    });
  }
  return changes;
}

/** The `deleted` change for an event Meetup confirmed it no longer has. */
export function deletionChange(previous: EventObservation): NewEventChange {
  return {
    ...lastSeen(previous),
    kind: 'deleted',
    oldValue: {
      status: previous.status,
      startAt: previous.startAt.toISOString(),
      rsvpYes: previous.rsvpYes,
    },
    newValue: null,
  };
}

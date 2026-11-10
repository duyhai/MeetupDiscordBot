/**
 * When a host's announcement goes out (leadership guidelines, Stacey and
 * Hai, 2026-11-10). Pure: dates in, a due time out.
 *
 * - Requested 10:00–16:00 Pacific on a weekday: held until 16:00 that day
 *   (Meetup emails the group at once, and work hours are the worst time).
 * - Within 30 minutes of another announcement (held, sending or sent): 30
 *   minutes after it, so the group never gets two emails back to back.
 * - An event starting within 3 days skips both and goes at once.
 *
 * Also the advice the page shows before the button: the guidelines, and a
 * warning (not a block) when the event is more than 3 weeks out.
 */
import dayjs, { Dayjs } from 'dayjs';

import { tz } from '../../util/timezone.js';

export const HOLD_FROM_HOUR = 10;
export const HOLD_UNTIL_HOUR = 16;
export const SPACING_MS = 30 * 60 * 1000;
/** Events starting within this go out at once. */
export const URGENT_DAYS = 3;
/** Beyond this the page warns that it is early. */
export const FAR_OUT_DAYS = 21;
/**
 * An event within this of its start can no longer be announced on Meetup,
 * unless it was created within the same span (a late-created event may be
 * announced late).
 */
export const MEETUP_CUTOFF_DAYS = 7;

/** True Mon–Fri 10:00 ≤ t < 16:00 Pacific. */
export function isHeldHour(at: Date): boolean {
  const local = tz(dayjs(at));
  const weekday = local.day();
  return (
    weekday >= 1 &&
    weekday <= 5 &&
    local.hour() >= HOLD_FROM_HOUR &&
    local.hour() < HOLD_UNTIL_HOUR
  );
}

/** 16:00 Pacific on the day of `at`. */
function holdEnd(at: Date): Dayjs {
  return tz(dayjs(at)).hour(HOLD_UNTIL_HOUR).minute(0).second(0).millisecond(0);
}

const within = (a: number, b: number, ms: number) => Math.abs(a - b) < ms;

/**
 * When an announcement requested at `now` for an event starting at
 * `eventStart` goes out, given the other announcements' times (held,
 * sending or sent) to keep SPACING_MS from.
 */
export function announceDueAt(
  now: Date,
  eventStart: Date,
  others: readonly Date[],
): Date {
  if (
    eventStart.getTime() - now.getTime() <
    URGENT_DAYS * 24 * 60 * 60 * 1000
  ) {
    return now;
  }
  let due = isHeldHour(now) ? holdEnd(now).valueOf() : now.getTime();
  const times = [...others].map((d) => d.getTime()).sort((a, b) => a - b);
  // Each push can land on another one, so go round until clear.
  let moved = true;
  while (moved) {
    moved = false;
    for (const other of times) {
      if (within(due, other, SPACING_MS)) {
        due = other + SPACING_MS;
        moved = true;
      }
    }
  }
  return new Date(due);
}

/** Whether the due time is now (within a minute), not a hold. */
export const isImmediate = (due: Date, now: Date): boolean =>
  due.getTime() - now.getTime() < 60 * 1000;

/**
 * Meetup refuses to announce an event within MEETUP_CUTOFF_DAYS of its
 * start unless it was created within that span. True when it will refuse.
 */
export function pastMeetupCutoff(
  now: Date,
  eventStart: Date,
  createdAt: Date,
): boolean {
  const cutoff = MEETUP_CUTOFF_DAYS * 24 * 60 * 60 * 1000;
  return (
    eventStart.getTime() - now.getTime() < cutoff &&
    eventStart.getTime() - createdAt.getTime() > cutoff
  );
}

/** True when the event is more than FAR_OUT_DAYS away: early, by the guidelines. */
export function isFarOut(now: Date, eventStart: Date): boolean {
  return (
    eventStart.getTime() - now.getTime() > FAR_OUT_DAYS * 24 * 60 * 60 * 1000
  );
}

/** Meetup's rsvpState values that mean members cannot RSVP yet. */
const RSVPS_NOT_OPEN = new Set(['NOT_OPEN_YET', 'CLOSED']);

export const rsvpsOpen = (rsvpState: string | null | undefined): boolean =>
  !RSVPS_NOT_OPEN.has(rsvpState ?? '');

/** "Tue, Nov 17 at 4:00 PM" in Pacific time. */
export const dueLabel = (due: Date): string =>
  tz(dayjs(due)).format('ddd, MMM D [at] h:mm A');

/** The guidelines, as the page shows them by the button. */
export const ANNOUNCE_GUIDELINES = [
  'Open RSVPs first.',
  'Announce 2–3 weeks ahead.',
  'Space it out from other announcements: anything within 30 minutes of another goes 30 minutes later.',
  'Not during work hours: a request made 10–4 Mon–Fri goes out at 4 pm.',
] as const;

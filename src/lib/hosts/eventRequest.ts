import dayjs from 'dayjs';

import { COMMUNITY_HOST_PREFIX, GUEST_HOST_PREFIX } from '../../constants.js';
import {
  GUEST_HOST_EVENT_DESCRIPTION,
  createEventTemplate,
} from '../../templates/createEventTemplate.js';
import { tz } from '../../util/timezone.js';
import {
  CreateEventInput,
  GetEventForCopyResponse,
} from '../client/meetup/types.js';
import {
  EVENT_REQUEST_TITLE_MAX,
  EventRequest,
  EventRequestFields,
} from '../repositories/postgresEventRequestRepository.js';
import type { HostTier } from './eligibility.js';
import { stripHostPrefix } from './eventTypes.js';

/** The lengths a host can pick. Meetup takes ISO 8601 durations. */
export const DURATIONS = [
  'PT1H',
  'PT1H30M',
  'PT2H',
  'PT2H30M',
  'PT3H',
  'PT4H',
  'PT5H',
  'PT6H',
] as const;
export type Duration = (typeof DURATIONS)[number];
export const DEFAULT_DURATION: Duration = 'PT2H';
export const DEFAULT_TIME = '19:00';

/** How far ahead a host may ask for an event. */
export const MAX_DAYS_AHEAD = 365;

/** 15-minute steps, HH:MM, 24-hour. */
export const START_TIMES: readonly string[] = Array.from(
  { length: 96 },
  (_, i) =>
    `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`,
);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Control characters, line breaks and the Unicode line/paragraph separators.
const UNPRINTABLE = /[\p{Cc}\u2028\u2029]/u;

export function prefixFor(tier: HostTier): string {
  return tier === 'promoted' ? COMMUNITY_HOST_PREFIX : GUEST_HOST_PREFIX;
}

/** The longest title a host of this tier can type: Meetup's 80 less the prefix. */
export const titleMaxFor = (tier: HostTier): number =>
  EVENT_REQUEST_TITLE_MAX - prefixFor(tier).length;

const length = (text: string) => Array.from(text).length;

export interface RequestForm {
  title: string;
  day: string;
  time: string;
  duration: Duration;
}

export type FormField = keyof RequestForm;

export type FormResult =
  | { ok: true; value: RequestForm }
  | { ok: false; errors: Partial<Record<FormField, string>> };

/** One form field as a string; a missing or repeated field (an array) is undefined. */
function field(
  body: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const value = body?.[name];
  return typeof value === 'string' ? value : undefined;
}

/** True for a real calendar date in YYYY-MM-DD (rejects 2026-02-30). */
const isRealDay = (day: string) =>
  DAY.test(day) && dayjs(day).format('YYYY-MM-DD') === day;

/**
 * The create form, checked. `today` is the Pacific date: an event can be
 * asked for from tomorrow through MAX_DAYS_AHEAD days out. Error texts are
 * fixed; nothing the host typed is echoed in them.
 */
export function parseRequestForm(
  body: Record<string, unknown> | undefined,
  tier: HostTier,
  today: string,
): FormResult {
  const errors: Partial<Record<FormField, string>> = {};
  const max = titleMaxFor(tier);

  const rawTitle = field(body, 'title');
  const title = rawTitle === undefined ? '' : stripHostPrefix(rawTitle).trim();
  if (rawTitle === undefined || title === '') {
    errors.title = 'Give the event a title.';
  } else if (UNPRINTABLE.test(title)) {
    errors.title = 'The title must be one line, with no special characters.';
  } else if (length(title) > max) {
    errors.title = `Keep the title to ${max} characters.`;
  }

  const day = field(body, 'day') ?? '';
  const last = dayjs(today).add(MAX_DAYS_AHEAD, 'day').format('YYYY-MM-DD');
  if (!isRealDay(day)) {
    errors.day = 'Pick a date.';
  } else if (day <= today) {
    errors.day = 'Pick a date from tomorrow on.';
  } else if (day > last) {
    errors.day = `Pick a date within the next ${MAX_DAYS_AHEAD} days.`;
  }

  const time = field(body, 'time') ?? '';
  if (!START_TIMES.includes(time)) {
    errors.time = 'Pick a start time.';
  }

  const duration = field(body, 'duration') ?? '';
  if (!(DURATIONS as readonly string[]).includes(duration)) {
    errors.duration = 'Pick how long the event runs.';
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: { title, day, time, duration: duration as Duration },
  };
}

export type CopySource = NonNullable<GetEventForCopyResponse['event']>;

/** True when this member is one of the event's hosts on Meetup. */
export function isHostOf(source: CopySource, meetupMemberId: string): boolean {
  return (source.eventHosts ?? []).some(
    (h) =>
      h?.member?.id !== undefined && String(h.member.id) === meetupMemberId,
  );
}

/** The settings a request carries besides its title, day, time and kind. */
export type RequestSettings = Pick<
  EventRequestFields,
  | 'description'
  | 'duration'
  | 'rsvpLimit'
  | 'guestLimit'
  | 'featuredPhotoId'
  | 'venueId'
  | 'howToFindUs'
>;

const TEMPLATE_RSVP = createEventTemplate.rsvpSettings;
const TEMPLATE_PHOTO = createEventTemplate.featuredPhotoId ?? null;
const VENUE_ID = /^[A-Za-z0-9_-]{1,40}$/;

const inRange = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

/**
 * A fresh event's settings: the guest-host description (regular hosts get
 * a Host Tip first, as the Discord flow does) and the template's limits.
 */
export function freshSettings(
  tier: HostTier,
  tip: string,
  duration: Duration,
): RequestSettings {
  return {
    description:
      tier === 'regular'
        ? `💡 Host Tip: ${tip} 💡\n\n${GUEST_HOST_EVENT_DESCRIPTION}`
        : GUEST_HOST_EVENT_DESCRIPTION,
    duration,
    rsvpLimit: TEMPLATE_RSVP.rsvpLimit,
    guestLimit: TEMPLATE_RSVP.guestLimit,
    featuredPhotoId: TEMPLATE_PHOTO,
    venueId: null,
    howToFindUs: null,
  };
}

/** What the form starts with when copying: the source's title, time and length. */
export function copyDefaults(source: CopySource): {
  title: string;
  time: string;
  duration: Duration;
} {
  const start = tz(dayjs(source.dateTime));
  // Rounded down to the form's 15-minute steps.
  const time = `${start.format('HH')}:${String(Math.floor(start.minute() / 15) * 15).padStart(2, '0')}`;
  return {
    title: stripHostPrefix(source.title ?? '').trim(),
    time: START_TIMES.includes(time) ? time : DEFAULT_TIME,
    duration: copyDuration(source.duration),
  };
}

function copyDuration(duration: string | null): Duration {
  return (DURATIONS as readonly string[]).includes(duration ?? '')
    ? (duration as Duration)
    : DEFAULT_DURATION;
}

/**
 * A copy's settings, taken from the source event: no tip is added. Values
 * outside what the form or the table allows fall back to the template's.
 */
export function copySettings(
  source: CopySource,
  duration: Duration,
): RequestSettings {
  const photo = Number(source.featuredEventPhoto?.id);
  const venue = source.venue?.id;
  const howTo = source.howToFindUs?.trim();
  return {
    description: source.description ?? '',
    duration,
    rsvpLimit: inRange(source.maxTickets, 1, 500)
      ? source.maxTickets
      : TEMPLATE_RSVP.rsvpLimit,
    guestLimit: inRange(source.guestLimit, 0, 10)
      ? source.guestLimit
      : TEMPLATE_RSVP.guestLimit,
    featuredPhotoId:
      Number.isSafeInteger(photo) && photo > 0 ? photo : TEMPLATE_PHOTO,
    venueId: typeof venue === 'string' && VENUE_ID.test(venue) ? venue : null,
    howToFindUs: howTo ? Array.from(howTo).slice(0, 2000).join('') : null,
  };
}

/**
 * The Meetup input for a request. The prefix follows `tierAtPublish`, the
 * tier re-checked when it is published, not the one it was submitted with.
 */
export function createInputFor(
  request: EventRequest,
  tierAtPublish: HostTier,
): CreateEventInput {
  const input: CreateEventInput = {
    ...createEventTemplate,
    title: `${prefixFor(tierAtPublish)}${request.title}`,
    description: request.description,
    startDateTime: request.startLocal,
    duration: request.duration,
    eventHosts: [Number(request.meetupMemberId)],
    rsvpSettings: {
      ...TEMPLATE_RSVP,
      rsvpLimit: request.rsvpLimit,
      guestLimit: request.guestLimit,
    },
    publishStatus: 'PUBLISHED',
  };
  if (request.featuredPhotoId === null) {
    delete input.featuredPhotoId;
  } else {
    input.featuredPhotoId = request.featuredPhotoId;
  }
  if (request.venueId !== null) {
    input.venueId = request.venueId;
  }
  if (request.howToFindUs !== null) {
    input.howToFindUs = request.howToFindUs;
  }
  return input;
}

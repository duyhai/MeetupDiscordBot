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
  GroupEventFilter,
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

/** A regular host may have at most this many requests waiting for leadership. */
export const MAX_PENDING = 5;

/** 15-minute steps, HH:MM, 24-hour. */
export const START_TIMES: readonly string[] = Array.from(
  { length: 96 },
  (_, i) =>
    `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`,
);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Control characters, line breaks, the Unicode line/paragraph separators,
// the bidi embeddings, overrides, isolates and marks (title spoofing) and
// the zero-width space. Not all of \p{Cf}: U+200D joins emoji.
const UNPRINTABLE =
  /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200E\u200F\u200B]/u;

export function prefixFor(tier: HostTier): string {
  return tier === 'promoted' ? COMMUNITY_HOST_PREFIX : GUEST_HOST_PREFIX;
}

/**
 * The longest title a host can type: Meetup's 80 less the longer prefix.
 * The prefix follows the tier when the event is published, which may not
 * be the tier it was asked with, so either must fit.
 */
export const TITLE_MAX =
  EVENT_REQUEST_TITLE_MAX -
  Math.max(GUEST_HOST_PREFIX.length, COMMUNITY_HOST_PREFIX.length);

const length = (text: string) => Array.from(text).length;

/** The longest description a host can type (the tip goes on top). */
export const DESCRIPTION_MAX = 10_000;
/** The RSVP and guest limits a host can set, as the table allows. */
export const RSVP_LIMIT_RANGE = { min: 1, max: 500 } as const;
export const GUEST_LIMIT_RANGE = { min: 0, max: 10 } as const;

// In a description: control characters other than tab and line breaks,
// and the bidi embeddings, overrides and isolates (spoofing).
const DESCRIPTION_UNPRINTABLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;

export interface RequestForm {
  title: string;
  day: string;
  time: string;
  duration: Duration;
  /**
   * The host's description, or null for the template's: left as it was
   * pre-filled, or blank. Line breaks are LF.
   */
  description: string | null;
  /** null when left blank: the template's limit. */
  rsvpLimit: number | null;
  guestLimit: number | null;
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
  today: string,
): FormResult {
  const errors: Partial<Record<FormField, string>> = {};
  const max = TITLE_MAX;

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

  const rawDescription = (field(body, 'description') ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  let description: string | null = null;
  if (
    rawDescription !== '' &&
    rawDescription !== GUEST_HOST_EVENT_DESCRIPTION.trim()
  ) {
    if (DESCRIPTION_UNPRINTABLE.test(rawDescription)) {
      errors.description = 'The description has characters Meetup cannot show.';
    } else if (length(rawDescription) > DESCRIPTION_MAX) {
      errors.description = `Keep the description to ${DESCRIPTION_MAX.toLocaleString('en-US')} characters.`;
    } else {
      description = rawDescription;
    }
  }

  const limit = (
    name: 'rsvpLimit' | 'guestLimit',
    range: { min: number; max: number },
    message: string,
  ): number | null => {
    const raw = (field(body, name) ?? '').trim();
    if (raw === '') {
      return null;
    }
    const n = /^[0-9]{1,4}$/.test(raw) ? Number(raw) : NaN;
    if (!(n >= range.min && n <= range.max)) {
      errors[name] = message;
      return null;
    }
    return n;
  };
  const rsvpLimit = limit(
    'rsvpLimit',
    RSVP_LIMIT_RANGE,
    `Enter an RSVP limit from ${RSVP_LIMIT_RANGE.min} to ${RSVP_LIMIT_RANGE.max}, or leave it blank.`,
  );
  const guestLimit = limit(
    'guestLimit',
    GUEST_LIMIT_RANGE,
    `Enter a guest limit from ${GUEST_LIMIT_RANGE.min} to ${GUEST_LIMIT_RANGE.max}, or leave it blank.`,
  );

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      title,
      day,
      time,
      duration: duration as Duration,
      description,
      rsvpLimit,
      guestLimit,
    },
  };
}

export type CopySource = NonNullable<GetEventForCopyResponse['event']>;

/**
 * True when this member may copy the event: it is one of this group's
 * events (the organizer login can read other groups' too) and the member
 * is one of its hosts.
 */
export function isHostOf(source: CopySource, meetupMemberId: string): boolean {
  if (source.group?.urlname !== createEventTemplate.groupUrlname) {
    return false;
  }
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

/** The host's optional choices on the fresh-event form; null means the template's. */
export type FreshChoices = Pick<
  RequestForm,
  'description' | 'rsvpLimit' | 'guestLimit'
>;

const NO_CHOICES: FreshChoices = {
  description: null,
  rsvpLimit: null,
  guestLimit: null,
};

/**
 * A fresh event's settings: the host's description or the guest-host one
 * (regular hosts get a Host Tip first, as the Discord flow does), and the
 * host's limits or the template's.
 */
export function freshSettings(
  tier: HostTier,
  tip: string,
  duration: Duration,
  choices: FreshChoices = NO_CHOICES,
): RequestSettings {
  const body = choices.description ?? GUEST_HOST_EVENT_DESCRIPTION;
  return {
    description:
      tier === 'regular' ? `💡 Host Tip: ${tip} 💡\n\n${body}` : body,
    duration,
    rsvpLimit: choices.rsvpLimit ?? TEMPLATE_RSVP.rsvpLimit,
    guestLimit: choices.guestLimit ?? TEMPLATE_RSVP.guestLimit,
    featuredPhotoId: TEMPLATE_PHOTO,
    venueId: null,
    howToFindUs: null,
  };
}

/**
 * True when a stored request is what this form would make: how a form sent
 * a second time with changes is told apart from a plain repeat. The tip is
 * random, so a fresh description is compared without it.
 */
export function formMatches(
  request: EventRequest,
  form: RequestForm,
  kind: 'fresh' | 'copy',
): boolean {
  if (
    request.title !== form.title ||
    request.startLocal !== `${form.day}T${form.time}` ||
    request.duration !== form.duration
  ) {
    return false;
  }
  if (kind === 'copy') {
    return true;
  }
  return (
    request.description.endsWith(
      form.description ?? GUEST_HOST_EVENT_DESCRIPTION,
    ) &&
    request.rsvpLimit === (form.rsvpLimit ?? TEMPLATE_RSVP.rsvpLimit) &&
    request.guestLimit === (form.guestLimit ?? TEMPLATE_RSVP.guestLimit)
  );
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

/**
 * True when a Meetup event is what this request became: its title is the
 * request's (whichever prefix) and it starts at the request's local time
 * in the group's timezone. How a retry recognises an event an earlier
 * attempt created but did not record.
 */
export function isEventFor(
  event: { title: string | null; dateTime: string },
  request: Pick<EventRequest, 'title' | 'startLocal'>,
): boolean {
  return (
    stripHostPrefix(event.title ?? '').trim() === request.title &&
    tz(dayjs(event.dateTime)).format('YYYY-MM-DDTHH:mm') === request.startLocal
  );
}

/**
 * The Meetup search for the event a request may already have become: the
 * requester's events from a day before its start to a day after, upcoming
 * or past. Past too, because a request is often checked after its start
 * (Deny of a past-dated failed request), when its event is no longer ACTIVE.
 */
export function existingEventFilter(
  request: Pick<EventRequest, 'meetupMemberId' | 'startLocal'>,
): GroupEventFilter {
  // A fixed 24 h either side, so across a DST change the window is off by
  // an hour at one end. That is safe: it is only a prefilter that always
  // still contains the start, and isEventFor then matches the exact
  // Pacific start time.
  const start = dayjs.tz(request.startLocal, 'America/Los_Angeles');
  return {
    hostId: request.meetupMemberId,
    status: ['ACTIVE', 'PAST'],
    afterDateTime: start.subtract(1, 'day').toISOString(),
    beforeDateTime: start.add(1, 'day').toISOString(),
  };
}

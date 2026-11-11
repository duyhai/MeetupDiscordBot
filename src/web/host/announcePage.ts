import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import {
  AnnounceCode,
  AnnounceOptions,
  CancelCode,
} from '../../lib/hosts/announceEvent.js';
import {
  ANNOUNCE_GUIDELINES,
  dueLabel,
  isFarOut,
} from '../../lib/hosts/announceSchedule.js';
import { HostEvent } from '../../lib/hosts/hostEvents.js';
import {
  RecreateCode,
  RecreateOutcome,
  Recreatable,
} from '../../lib/hosts/recreateEvent.js';
import {
  AnnounceConfirmation,
  Announcement,
  isStaleSending,
} from '../../lib/repositories/postgresEventAnnouncementRepository.js';
import {
  SafeHtml,
  html,
  localUrl,
  memberText,
  pageLink,
  safeHref,
} from '../html.js';
import { dateLabel, hostPage, timeLabel, unavailable } from './hostPageKit.js';
import { hostLocals } from './hostRouter.js';
import { HOST_BASE } from './hostSession.js';

const logger = new Logger({ name: 'hostDashboard' });

const EVENT_ID = /^[0-9]{1,20}$/;
/**
 * How long the page waits for Meetup once the send is under way. It goes
 * on after the page stops waiting; its row says "announcing" until Meetup
 * answers.
 */
const ANNOUNCE_DEADLINE_MS = 20_000;
/** A recreate is a create, an announce and a cancel: longer, still inside Heroku's 30 s. */
const RECREATE_DEADLINE_MS = 25_000;

type Host = { meetupMemberId: string; name: string };

export interface AnnounceRouteDeps {
  /** announceHostEvent on the production deps; the confirmation goes on the row. */
  announce: (
    host: Host,
    meetupEventId: string,
    options: AnnounceOptions & { confirmation: AnnounceConfirmation },
  ) => Promise<AnnounceCode>;
  /** Each event's announcement, if any. */
  announcements: (
    meetupEventIds: string[],
  ) => Promise<Map<string, Announcement>>;
  /** Cancels the host's held announcement. */
  cancel: (host: Host, meetupEventId: string) => Promise<CancelCode>;
  /** Whether "Recreate and announce" may be offered for the event, and why not. */
  recreatable: (host: Host, meetupEventId: string) => Promise<Recreatable>;
  /** recreateAndAnnounce on the production deps; the confirmation goes on the copy's row. */
  recreate: (
    host: Host,
    meetupEventId: string,
    confirmation: AnnounceConfirmation,
  ) => Promise<RecreateOutcome>;
  /** Tests only. */
  deadlineMs?: number;
}

/** What the confirm pages read: the host's own upcoming events, and the clock. */
export interface AnnounceEventsDeps {
  ownUpcoming: (meetupMemberId: string) => Promise<HostEvent[]>;
  now: () => Date;
}

/**
 * The pre-flight checks (leadership, 2026-11-11): every announcement, and
 * every recreate-and-announce, is accepted only once the host has ticked
 * all three. Short on purpose: hosts skim.
 */
export const ANNOUNCE_CHECKS = {
  photo: 'The event photo is set (not the default)',
  location:
    "The exact location is NOT in the title (it's in the event details)",
  rsvps: 'RSVPs are open',
} as const;
const CHECK_NAMES = Object.keys(
  ANNOUNCE_CHECKS,
) as (keyof typeof ANNOUNCE_CHECKS)[];

export const CONFIRM_ALL_MESSAGE =
  'Tick all three to confirm before announcing. Nothing was sent.';

/**
 * The confirmation from the form body: every box ticked ("on", as a
 * checkbox sends it), stamped now. Undefined when any is missing, so the
 * caller shows the page again and announces nothing.
 */
export function parseConfirmation(
  body: unknown,
  now: Date,
): AnnounceConfirmation | undefined {
  const fields = (body ?? {}) as Record<string, unknown>;
  if (!CHECK_NAMES.every((name) => fields[name] === 'on')) {
    return undefined;
  }
  return {
    photoSet: true,
    locationNotInTitle: true,
    rsvpsOpen: true,
    confirmedAt: now.toISOString(),
  };
}

/** Every `?announce=` code: the outcomes, a slow Meetup, or a failure here. */
export const ANNOUNCE_NOTICES: Record<
  AnnounceCode | CancelCode | RecreateCode | 'slow' | 'error',
  { ok: boolean; text: string }
> = {
  sent: {
    ok: true,
    text: 'Announced. Meetup is emailing the group about your event.',
  },
  scheduled: {
    ok: true,
    text:
      'Scheduled. The time is by the event below; it goes out then unless you ' +
      'cancel it.',
  },
  already: {
    ok: true,
    text: 'That event was already announced, so nothing was sent again.',
  },
  'in-progress': {
    ok: true,
    text: 'That announcement is already being sent. Reload in a minute to see how it went.',
  },
  unconfirmed: {
    ok: false,
    text:
      'Meetup did not confirm the announcement, so it may or may not have ' +
      'gone out. You can try again: Meetup refuses it if it already went out.',
  },
  failed: {
    ok: false,
    text: 'Meetup refused the announcement. You can try again; the organizers have been told.',
  },
  'not-yours': {
    ok: false,
    text: 'You can only announce your own upcoming events.',
  },
  'rsvps-closed': {
    ok: false,
    text:
      'RSVPs are not open for that event yet. Open them on Meetup first, then ' +
      'announce it.',
  },
  'too-late': {
    ok: false,
    text:
      'Meetup will not announce an event within 7 days of its start when it was ' +
      'created more than 7 days before it. See the event below for what you can do.',
  },
  cancelled: {
    ok: true,
    text: 'The scheduled announcement was cancelled. Nothing was sent.',
  },
  'not-held': {
    ok: false,
    text: 'That announcement was not waiting to go out, so there was nothing to cancel.',
  },
  recreated: {
    ok: true,
    text:
      'Done: your event was recreated and the copy is announced; the old one ' +
      'is cancelled. RSVPs are open on the copy.',
  },
  'recreated-scheduled': {
    ok: true,
    text:
      'Done: your event was recreated and the old one is cancelled. The copy’s ' +
      'announcement goes out at the time shown by it below; you can cancel ' +
      'that until then.',
  },
  'recreated-old-kept': {
    ok: true,
    text:
      'Your event was recreated and the copy is announced (or scheduled, see ' +
      'below). The old one is still on Meetup for now: the organizers have ' +
      'been asked to cancel it.',
  },
  'rsvps-unknown': {
    ok: false,
    text:
      'Meetup did not say whether RSVPs are open for that event. Check it on ' +
      'Meetup, then try again.',
  },
  'has-rsvps': {
    ok: false,
    text:
      'Someone other than the hosts has RSVPed, so the event was not recreated. ' +
      'Ask an organizer if you still want it announced.',
  },
  'recreate-in-progress': {
    ok: true,
    text: 'That event is being recreated right now. Reload in a minute to see how it went.',
  },
  'recreate-needs-check': {
    ok: false,
    text:
      'Meetup did not say whether the copy was made, so nothing more was done ' +
      'and your old event is untouched. The organizers have been asked to check ' +
      'Meetup and finish it by hand; please do not try again.',
  },
  'already-recreated': {
    ok: false,
    text: 'That event was already recreated once. The copy is in your upcoming events.',
  },
  'no-source': {
    ok: false,
    text: 'Meetup could not give the event’s details to copy. Nothing was changed.',
  },
  'create-failed': {
    ok: false,
    text:
      'The copy could not be created on Meetup, so nothing was changed. The ' +
      'organizers have been told; you can try again in a minute.',
  },
  'announce-failed': {
    ok: false,
    text:
      'The copy was created, but its announcement did not go out, so the old ' +
      'event was left in place. The organizers have been told; they will ' +
      'announce the copy and cancel the old one by hand. Nothing more to do ' +
      'here.',
  },
  'cancel-failed': {
    ok: false,
    text:
      'The copy was created and its announcement is on its way, but Meetup did ' +
      'not cancel the old event. The organizers have been told.',
  },
  slow: {
    ok: true,
    text: 'Still waiting on Meetup. Reload in a minute to see whether it went out.',
  },
  error: {
    ok: false,
    text: 'That did not work, and nothing was sent. Please try again in a minute.',
  },
};

type AnnounceNoticeCode = keyof typeof ANNOUNCE_NOTICES;

/** The home page's notice for `?announce=`, or nothing. */
export function announceNotice(value: unknown): SafeHtml | '' {
  if (typeof value !== 'string' || !Object.hasOwn(ANNOUNCE_NOTICES, value)) {
    return '';
  }
  const { ok, text } = ANNOUNCE_NOTICES[value as AnnounceNoticeCode];
  return ok
    ? html`<p class="note info">${text}</p>`
    : html`<p class="note attn">${text}</p>`;
}

export const announcePath = (eventId: string) =>
  `${HOST_BASE}/events/${eventId}/announce`;
export const cancelAnnouncePath = (eventId: string) =>
  `${HOST_BASE}/events/${eventId}/announce/cancel`;
export const recreatePath = (eventId: string) =>
  `${HOST_BASE}/events/${eventId}/recreate`;

/**
 * The confirm page: the event, the three required checks, Confirm and
 * announce. The same page for Announce and for Recreate and announce; the
 * latter says what it does. `refused` shows the message after a POST with
 * a box unticked.
 */
/**
 * Which boxes a refused POST had ticked, so the page comes back as sent.
 * (The markup below is literal twice per box: the template takes no
 * interpolated attribute names, `checked` included.)
 */
export type Ticked = Partial<Record<keyof typeof ANNOUNCE_CHECKS, boolean>>;

export function tickedIn(body: unknown): Ticked {
  const fields = (body ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    CHECK_NAMES.map((name) => [name, fields[name] === 'on']),
  );
}

export function confirmBody(
  event: HostEvent,
  kind: 'announce' | 'recreate',
  csrf: string,
  refused = false,
  ticked: Ticked = {},
): SafeHtml {
  const meetup = safeHref(event.eventUrl);
  const action = kind === 'announce' ? announcePath : recreatePath;
  return html`<div class="card announce-confirm">
    <h1>
      ${kind === 'announce' ? 'Announce this event' : 'Recreate and announce'}
    </h1>
    <p>
      <strong>${memberText(event.title)}</strong><br />
      ${dateLabel(event.dateTime)}, ${timeLabel(event.dateTime)}
    </p>
    ${
      kind === 'recreate'
        ? html`<p class="muted">
            A copy (same title, description, photo, venue and hosts) is created
            and announced, and this event is cancelled. The copy may be
            scheduled under the usual rules.
          </p>`
        : ''
    }
    ${refused ? html`<p class="note attn">${CONFIRM_ALL_MESSAGE}</p>` : ''}
    <form method="post" action="${localUrl(action(event.id))}">
      <input type="hidden" name="_csrf" value="${csrf}" />
      <fieldset class="review-checklist">
        <legend>Before it goes out, confirm on Meetup that:</legend>
        <label class="check">
          ${
            ticked.photo
              ? html`<input type="checkbox" name="photo" required checked />`
              : html`<input type="checkbox" name="photo" required />`
          }
          ${ANNOUNCE_CHECKS.photo}
        </label>
        <label class="check">
          ${
            ticked.location
              ? html`<input type="checkbox" name="location" required checked />`
              : html`<input type="checkbox" name="location" required />`
          }
          ${ANNOUNCE_CHECKS.location}
        </label>
        <label class="check">
          ${
            ticked.rsvps
              ? html`<input type="checkbox" name="rsvps" required checked />`
              : html`<input type="checkbox" name="rsvps" required />`
          }
          ${ANNOUNCE_CHECKS.rsvps}
        </label>
      </fieldset>
      <div class="actions">
        <button type="submit">Confirm and announce</button>
        <a class="button ghost" href="${pageLink(HOST_BASE)}">Back</a>
        ${
          meetup
            ? html`<a
                class="button ghost"
                href="${meetup}"
                rel="noopener noreferrer"
                target="_blank"
                >Check it on Meetup</a
              >`
            : ''
        }
      </div>
    </form>
  </div>`;
}

/** The guidelines, by the Announce buttons. */
export function announceGuidelines(): SafeHtml {
  return html`<details class="announce-guidelines">
    <summary>Announcing: the guidelines</summary>
    <ul>
      ${ANNOUNCE_GUIDELINES.map((line) => html`<li>${line}</li>`)}
      <li>
        An event starting within 3 days goes out at once. Meetup will not
        announce an event within 7 days of its start unless it was created in
        that week.
      </li>
    </ul>
  </details>`;
}

/** What the row means now: a send cut off by a restart is unconfirmed. */
function stateOf(
  a: Announcement | undefined,
  now: Date,
): Announcement['status'] | undefined {
  if (a === undefined) {
    return undefined;
  }
  return isStaleSending(a, now) ? 'unknown' : a.status;
}

/** The event's status badge for its announcement, if any. */
export function announceBadge(
  a: Announcement | undefined,
  now: Date,
): SafeHtml | '' {
  switch (stateOf(a, now)) {
    case 'sent':
      return html`<span class="badge ok">Announced</span>`;
    case 'held':
      // Past its time: waiting on the spacing rule or a Meetup outage.
      return a?.dueAt && a.dueAt.getTime() <= now.getTime()
        ? html`<span class="badge info wrap"
            >Announcement going out shortly</span
          >`
        : html`<span class="badge info wrap"
            >Announcement scheduled for
            ${a?.dueAt ? dueLabel(a.dueAt) : 'later'}</span
          >`;
    case 'sending':
      return html`<span class="badge info">Announcing</span>`;
    case 'unknown':
      return html`<span class="badge attn">Announcement not confirmed</span>`;
    case 'failed':
      return html`<span class="badge attn">Announcement refused</span>`;
    default:
      return '';
  }
}

/**
 * The event's Announce button: a disabled one once it is announced or on
 * its way, Cancel for a held one, else a link to the confirm page ("Try
 * announcing again" after a refused or unconfirmed send). More than 3
 * weeks out: a warning line, and the button still works. The server
 * decides either way.
 */
export function announceButton(
  event: HostEvent,
  a: Announcement | undefined,
  csrf: string,
  now: Date,
): SafeHtml | '' {
  const state = stateOf(a, now);
  if (state === 'sent') {
    return html`<button type="button" class="secondary" disabled>
      Announced
    </button>`;
  }
  if (state === 'sending') {
    return html`<button type="button" class="secondary" disabled>
      Announcing…
    </button>`;
  }
  if (!EVENT_ID.test(event.id)) {
    return '';
  }
  if (state === 'held') {
    return html`<form
      method="post"
      action="${localUrl(cancelAnnouncePath(event.id))}"
    >
      <input type="hidden" name="_csrf" value="${csrf}" />
      <button type="submit" class="secondary">Cancel the announcement</button>
    </form>`;
  }
  const early = isFarOut(now, new Date(event.dateTime))
    ? html`<p class="note attn announce-early">
        More than 3 weeks away: the guidelines say 2–3 weeks ahead. You can
        still announce it now.
      </p>`
    : '';
  return html`<div>
    ${early}
    <a class="button" href="${pageLink(announcePath(event.id))}">
      ${
        state === undefined || state === 'cancelled'
          ? 'Announce'
          : 'Try announcing again'
      }
    </a>
  </div>`;
}

function reasonOf(
  offer: Recreatable | undefined,
): Exclude<Recreatable, { ok: true }>['reason'] | undefined {
  if (offer === undefined || offer.ok === true) {
    return undefined;
  }
  return offer.reason;
}

/** Every too-late message leads with this (Kristen's wording, 2026-11-11). */
export const TOO_LATE_LEAD = "It's too late for Meetup to announce this event!";

/**
 * After a "too late" refusal: the Recreate and announce button (to its
 * confirm page) when the event has no RSVPs but the hosts', else why it is
 * not offered. `offer` undefined means the check itself failed.
 */
export function recreateOffer(
  event: HostEvent,
  offer: Recreatable | undefined,
): SafeHtml {
  const meetup = safeHref(event.eventUrl);
  if (offer?.ok) {
    return html`<div class="note attn recreate-offer">
      <p>
        ${TOO_LATE_LEAD} The only workaround is to recreate the event, and
        nobody except the hosts has RSVPed, so that is possible: the copy (same
        title, description, photo, venue and hosts) is created and announced,
        and this one is cancelled. The copy may be scheduled under the usual
        rules.
      </p>
      <p>
        <a class="button" href="${pageLink(recreatePath(event.id))}"
          >Recreate and announce</a
        >
      </p>
    </div>`;
  }
  const reason = reasonOf(offer);
  let why: string;
  if (offer === undefined) {
    why =
      'Whether it can be recreated could not be checked just now; reload in a minute.';
  } else if (reason === 'has-rsvps') {
    why =
      "The only workaround is to recreate the event — but that's not possible " +
      'because someone is already signed up.';
  } else if (reason === 'in-progress') {
    why =
      'A recreation of it is under way or needs checking; ask an organizer ' +
      'before trying anything else.';
  } else if (reason === 'already-recreated') {
    why = 'It was already recreated once; the copy is in your upcoming events.';
  } else {
    why = 'It is not one of your upcoming events.';
  }
  return html`<div class="note attn recreate-offer">
    <p>${TOO_LATE_LEAD} ${why}</p>
    ${
      meetup
        ? html`<p>
            <a href="${meetup}" rel="noopener noreferrer" target="_blank"
              >Open it on Meetup</a
            >
          </p>`
        : ''
    }
  </div>`;
}

/** `?event=` beside a too-late notice: the event the offer is for, or nothing. */
export function tooLateEvent(query: {
  announce?: unknown;
  event?: unknown;
}): string | undefined {
  return query.announce === 'too-late' &&
    typeof query.event === 'string' &&
    EVENT_ID.test(query.event)
    ? query.event
    : undefined;
}

function notFound(res: express.Response) {
  hostPage(res, {
    title: 'Not found',
    status: 404,
    body: html`<div class="card">
      <h1>Not found</h1>
      <p>That page does not exist, or it is not yours.</p>
    </div>`,
  });
}

/**
 * GET /host/events/:eventId/announce and .../recreate (the confirm page),
 * POST /host/events/:eventId/announce (Meetup's announcement email for one
 * of the host's own upcoming events, once, or a hold), .../announce/cancel
 * (a held one) and POST /host/events/:eventId/recreate. The two announcing
 * POSTs need the three confirmations ticked, else the page comes back with
 * the message and nothing happens. The router's unsafe-method guard
 * (session, CSRF, Origin, rate limit) runs first.
 */
export function registerAnnounceRoute(
  router: express.Router,
  deps: AnnounceRouteDeps,
  events: AnnounceEventsDeps,
): void {
  const hostOf = (res: express.Response): Host => {
    const { session } = hostLocals(res);
    return { meetupMemberId: session.userId, name: session.username };
  };
  const warn = (what: string, error: unknown) => {
    logger.warn(`${what}: ${error instanceof Error ? error.name : 'Error'}`);
  };
  /**
   * The host's own event for the confirm page, as the home page lists it.
   * 'answered' when the response is already sent (not theirs, or Meetup
   * down).
   */
  const ownEvent = async (
    res: express.Response,
    eventId: unknown,
  ): Promise<HostEvent | 'answered'> => {
    if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) {
      notFound(res);
      return 'answered';
    }
    let own: HostEvent[];
    try {
      own = await events.ownUpcoming(hostOf(res).meetupMemberId);
    } catch (error: unknown) {
      unavailable(res, error);
      return 'answered';
    }
    const event = own.find((e) => e.id === eventId);
    if (event === undefined) {
      notFound(res);
      return 'answered';
    }
    return event;
  };
  const confirmPage = async (
    req: express.Request,
    res: express.Response,
    kind: 'announce' | 'recreate',
    refused: boolean,
  ) => {
    const event = await ownEvent(res, req.params.eventId);
    if (event === 'answered') {
      return;
    }
    hostPage(res, {
      title: kind === 'announce' ? 'Announce' : 'Recreate and announce',
      current: 'home',
      status: refused ? 422 : 200,
      body: confirmBody(
        event,
        kind,
        hostLocals(res).session.csrfToken,
        refused,
        refused ? tickedIn(req.body) : {},
      ),
    });
  };
  /**
   * True when the event's announcement is done or under way (sent, held,
   * or a fresh send), so the confirm page has nothing to offer: a stale
   * bookmark goes back home instead. A row read that fails lets the page
   * show; the server refuses a second send anyway.
   */
  const settled = async (eventId: string): Promise<boolean> => {
    try {
      const state = stateOf(
        (await deps.announcements([eventId])).get(eventId),
        events.now(),
      );
      return state === 'sent' || state === 'held' || state === 'sending';
    } catch (error: unknown) {
      warn('Confirm page announcement read failed', error);
      return false;
    }
  };
  const confirmGet =
    (kind: 'announce' | 'recreate'): RequestHandler =>
    async (req, res) => {
      const { eventId } = req.params;
      if (typeof eventId === 'string' && EVENT_ID.test(eventId)) {
        if (await settled(eventId)) {
          res.redirect(303, HOST_BASE);
          return;
        }
      }
      await confirmPage(req, res, kind, false);
    };

  router.get('/events/:eventId/announce', confirmGet('announce'));
  router.get('/events/:eventId/recreate', confirmGet('recreate'));

  router.post('/events/:eventId/announce', (async (req, res) => {
    const { eventId } = req.params;
    if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) {
      res.redirect(303, `${HOST_BASE}?announce=not-yours`);
      return;
    }
    const confirmation = parseConfirmation(req.body, events.now());
    if (confirmation === undefined) {
      await confirmPage(req, res, 'announce', true);
      return;
    }
    const back = (code: AnnounceNoticeCode) =>
      res.redirect(
        303,
        code === 'too-late'
          ? `${HOST_BASE}?announce=too-late&event=${eventId}`
          : `${HOST_BASE}?announce=${code}`,
      );
    // The deadline starts once Meetup is about to be called: a slow events
    // read that ends in "not yours" never says "still waiting".
    let timer: NodeJS.Timeout | undefined;
    let answered = false;
    let startDeadline = () => undefined as void;
    const slow = new Promise<'slow'>((resolve) => {
      startDeadline = () => {
        timer = setTimeout(() => {
          resolve('slow');
        }, deps.deadlineMs ?? ANNOUNCE_DEADLINE_MS);
      };
    });
    const run = deps.announce(hostOf(res), eventId, {
      onClaimed: () => startDeadline(),
      confirmation,
    });
    // Still handled, and logged, if it fails after the page stopped waiting.
    run.catch((error: unknown) => {
      if (answered) {
        warn('Host announce failed after the page answered', error);
      }
    });
    try {
      const code = await Promise.race([run, slow]);
      answered = true;
      back(code);
    } catch (error: unknown) {
      answered = true;
      warn('Host announce failed', error);
      back('error');
    } finally {
      clearTimeout(timer);
    }
  }) as RequestHandler);

  router.post('/events/:eventId/announce/cancel', (async (req, res) => {
    const { eventId } = req.params;
    if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) {
      res.redirect(303, `${HOST_BASE}?announce=not-yours`);
      return;
    }
    try {
      const code = await deps.cancel(hostOf(res), eventId);
      res.redirect(303, `${HOST_BASE}?announce=${code}`);
    } catch (error: unknown) {
      warn('Host announce cancel failed', error);
      res.redirect(303, `${HOST_BASE}?announce=error`);
    }
  }) as RequestHandler);

  router.post('/events/:eventId/recreate', (async (req, res) => {
    const { eventId } = req.params;
    if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) {
      res.redirect(303, `${HOST_BASE}?announce=not-yours`);
      return;
    }
    const confirmation = parseConfirmation(req.body, events.now());
    if (confirmation === undefined) {
      await confirmPage(req, res, 'recreate', true);
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    let answered = false;
    const slow = new Promise<'slow'>((resolve) => {
      timer = setTimeout(() => {
        resolve('slow');
      }, deps.deadlineMs ?? RECREATE_DEADLINE_MS);
    });
    const run = deps.recreate(hostOf(res), eventId, confirmation);
    run.catch((error: unknown) => {
      if (answered) {
        warn('Host recreate failed after the page answered', error);
      }
    });
    try {
      const outcome = await Promise.race([run, slow]);
      answered = true;
      res.redirect(
        303,
        `${HOST_BASE}?announce=${outcome === 'slow' ? 'slow' : outcome.code}`,
      );
    } catch (error: unknown) {
      answered = true;
      warn('Host recreate failed', error);
      res.redirect(303, `${HOST_BASE}?announce=error`);
    } finally {
      clearTimeout(timer);
    }
  }) as RequestHandler);
}

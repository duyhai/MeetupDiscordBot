import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import { AnnounceCode } from '../../lib/hosts/announceEvent.js';
import { HostEvent } from '../../lib/hosts/hostEvents.js';
import {
  Announcement,
  isStaleSending,
} from '../../lib/repositories/postgresEventAnnouncementRepository.js';
import { SafeHtml, html, localUrl } from '../html.js';
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

export interface AnnounceRouteDeps {
  /** announceHostEvent on the production deps. */
  announce: (
    host: { meetupMemberId: string; name: string },
    meetupEventId: string,
    hooks: { onClaimed?: () => void },
  ) => Promise<AnnounceCode>;
  /** Each event's announcement, if any. */
  announcements: (
    meetupEventIds: string[],
  ) => Promise<Map<string, Announcement>>;
  /** Tests only. */
  deadlineMs?: number;
}

/** Every `?announce=` code: the outcomes, a slow Meetup, or a failure here. */
export const ANNOUNCE_NOTICES: Record<
  AnnounceCode | 'slow' | 'error',
  { ok: boolean; text: string }
> = {
  sent: {
    ok: true,
    text: 'Announced. Meetup is emailing the group about your event.',
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
 * its way, else a form ("Try announcing again" after a refused or
 * unconfirmed send). The server decides either way.
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
  return html`<form method="post" action="${localUrl(announcePath(event.id))}">
    <input type="hidden" name="_csrf" value="${csrf}" />
    <button type="submit">
      ${state === undefined ? 'Announce' : 'Try announcing again'}
    </button>
  </form>`;
}

/**
 * POST /host/events/:eventId/announce: Meetup's announcement email for one
 * of the host's own upcoming events, once. The router's unsafe-method guard
 * (session, CSRF, Origin, rate limit) runs first.
 */
export function registerAnnounceRoute(
  router: express.Router,
  deps: AnnounceRouteDeps,
): void {
  router.post('/events/:eventId/announce', (async (req, res) => {
    const { eventId } = req.params;
    if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) {
      res.redirect(303, `${HOST_BASE}?announce=not-yours`);
      return;
    }
    const { session } = hostLocals(res);
    const back = (code: AnnounceNoticeCode) =>
      res.redirect(303, `${HOST_BASE}?announce=${code}`);
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
    const run = deps.announce(
      { meetupMemberId: session.userId, name: session.username },
      eventId,
      { onClaimed: () => startDeadline() },
    );
    // Still handled, and logged, if it fails after the page stopped waiting.
    run.catch((error: unknown) => {
      if (answered) {
        logger.warn(
          `Host announce failed after the page answered: ${error instanceof Error ? error.name : 'Error'}`,
        );
      }
    });
    try {
      const code = await Promise.race([run, slow]);
      answered = true;
      back(code);
    } catch (error: unknown) {
      answered = true;
      logger.warn(
        `Host announce failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      back('error');
    } finally {
      clearTimeout(timer);
    }
  }) as RequestHandler);
}

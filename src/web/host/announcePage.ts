import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import { AnnounceCode } from '../../lib/hosts/announceEvent.js';
import { HostEvent } from '../../lib/hosts/hostEvents.js';
import { Announcement } from '../../lib/repositories/postgresEventAnnouncementRepository.js';
import { SafeHtml, html, localUrl } from '../html.js';
import { hostLocals } from './hostRouter.js';
import { HOST_BASE } from './hostSession.js';

const logger = new Logger({ name: 'hostDashboard' });

const EVENT_ID = /^[0-9]{1,20}$/;
/**
 * How long the page waits for Meetup. The send goes on after it stops
 * waiting; its row says "announcing" until Meetup answers.
 */
const ANNOUNCE_DEADLINE_MS = 20_000;

export interface AnnounceRouteDeps {
  /** announceHostEvent on the production deps. */
  announce: (
    host: { meetupMemberId: string; name: string },
    meetupEventId: string,
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
    text: 'That announcement is already being sent. Reload in a minute to see it done.',
  },
  unconfirmed: {
    ok: false,
    text:
      'Meetup did not confirm an earlier try, so it may already have gone out. ' +
      'It will not be sent again from here; the organizers have been told and ' +
      'will check it on Meetup.',
  },
  failed: {
    ok: false,
    text: 'Meetup refused the announcement, so nothing went out. You can try again; the organizers have been told.',
  },
  'not-yours': {
    ok: false,
    text: 'You can only announce your own upcoming events.',
  },
  slow: {
    ok: true,
    text: 'Meetup is slow to answer. The announcement is on its way; reload in a minute to see it done.',
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

/** The event's status badge for its announcement, if any. */
export function announceBadge(a: Announcement | undefined): SafeHtml | '' {
  switch (a?.status) {
    case 'sent':
      return html`<span class="badge ok">Announced</span>`;
    case 'sending':
      return html`<span class="badge info">Announcing</span>`;
    case 'unknown':
      return html`<span class="badge attn">Announcement unconfirmed</span>`;
    default:
      return '';
  }
}

/**
 * The event's Announce button: a form for one never announced (or refused),
 * a disabled button once it is announced or on its way, none while it is
 * unconfirmed. The server decides either way; this only saves a click.
 */
export function announceButton(
  event: HostEvent,
  a: Announcement | undefined,
  csrf: string,
): SafeHtml | '' {
  if (a?.status === 'sent') {
    return html`<button type="button" class="secondary" disabled>
      Announced
    </button>`;
  }
  if (a?.status === 'sending') {
    return html`<button type="button" class="secondary" disabled>
      Announcing…
    </button>`;
  }
  if (a?.status === 'unknown' || !EVENT_ID.test(event.id)) {
    return '';
  }
  return html`<form method="post" action="${localUrl(announcePath(event.id))}">
    <input type="hidden" name="_csrf" value="${csrf}" />
    <button type="submit">
      ${a?.status === 'failed' ? 'Try announcing again' : 'Announce'}
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
    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<'slow'>((resolve) => {
      timer = setTimeout(() => {
        resolve('slow');
      }, deps.deadlineMs ?? ANNOUNCE_DEADLINE_MS);
    });
    const run = deps.announce(
      { meetupMemberId: session.userId, name: session.username },
      eventId,
    );
    // Still handled if it fails after the page stopped waiting.
    run.catch(() => undefined);
    try {
      back(await Promise.race([run, slow]));
    } catch (error: unknown) {
      logger.warn(
        `Host announce failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
      back('error');
    } finally {
      clearTimeout(timer);
    }
  }) as RequestHandler);
}

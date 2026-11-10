import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AnnounceDeps,
  AnnounceEventDetails,
  announceHostEvent,
  cancelHeldAnnouncement,
} from '../../../src/lib/hosts/announceEvent.js';
import { HostEvent } from '../../../src/lib/hosts/hostEvents.js';
import {
  RecreateOutcome,
  Recreatable,
} from '../../../src/lib/hosts/recreateEvent.js';
import { Announcement } from '../../../src/lib/repositories/postgresEventAnnouncementRepository.js';
import { createHostRouter } from '../../../src/web/host/hostRouter.js';
import { registerHostPages } from '../../../src/web/host/hostPages.js';
import { clientFor, listen } from '../../setup/loopbackServer.js';
import {
  MEETUP_SELF,
  ORIGIN,
  closeServers,
  makeHostDeps,
  signInWithDiscord,
} from './hostHarness.js';

afterEach(closeServers);

// Tue 3 Nov 2026, 10:00 PST: inside the work-hours hold.
const NOW = new Date('2026-11-03T18:00:00Z');
// Same day, 19:00 PST: outside it.
const EVENING = new Date('2026-11-04T03:00:00Z');
const MINE = '311111111';
const THEIRS = '322222222';
const SOON = '333333333';

const ev = (
  id: string,
  hostId = MEETUP_SELF.id,
  dateTime = '2026-11-10T19:00:00-08:00',
): HostEvent => ({
  id,
  title: `Event ${id}`,
  dateTime,
  eventUrl: `https://www.meetup.com/g/events/${id}/`,
  type: 'social',
  hosts: [{ id: hostId, name: 'Ann' }],
});

const row = (
  id: string,
  status: Announcement['status'],
  extra: Partial<Announcement> = {},
): Announcement => ({
  meetupEventId: id,
  requestedBy: MEETUP_SELF.id,
  status,
  failure: null,
  requestedAt: NOW,
  completedAt: null,
  dueAt: null,
  ...extra,
});

/** The real announceHostEvent on an in-memory table with Postgres's claim and hold. */
function announceApp(
  options: {
    announce?: () => Promise<void>;
    readFails?: boolean;
    ownUpcomingDelayMs?: number;
    now?: Date;
    details?: Partial<AnnounceEventDetails>;
    recreatable?: Recreatable | Error;
    recreate?: RecreateOutcome | Error | 'never';
  } = {},
) {
  const rows = new Map<string, Announcement>();
  const now = options.now ?? EVENING;
  const reclaimable = (current: Announcement | undefined) =>
    current === undefined ||
    ['failed', 'unknown', 'cancelled'].includes(current.status);
  const store = {
    claim: vi.fn(async (id: string, by: string) => {
      const current = rows.get(id);
      if (reclaimable(current)) {
        rows.set(id, row(id, 'sending', { requestedBy: by }));
        return { claimed: true as const };
      }
      return { claimed: false as const, current: current };
    }),
    hold: vi.fn(async (id: string, by: string, dueAt: Date) => {
      const current = rows.get(id);
      if (reclaimable(current)) {
        rows.set(id, row(id, 'held', { requestedBy: by, dueAt }));
        return { held: true as const };
      }
      return { held: false as const, current: current };
    }),
    finish: vi.fn(
      async (
        id: string,
        status: Announcement['status'],
        failure: string | null = null,
      ) => {
        const current = rows.get(id);
        if (current?.status === 'sending') {
          rows.set(id, { ...current, status, failure });
        }
      },
    ),
    otherTimes: vi.fn(async () => [] as Date[]),
    cancelHeld: vi.fn(async (id: string) => {
      const current = rows.get(id);
      if (current?.status !== 'held') {
        return false;
      }
      rows.set(id, { ...current, status: 'cancelled' });
      return true;
    }),
  };
  const ownUpcoming = async (memberId: string) => {
    await new Promise((resolve) => {
      setTimeout(resolve, options.ownUpcomingDelayMs ?? 0);
    });
    return memberId === MEETUP_SELF.id
      ? [ev(MINE), ev(SOON, MEETUP_SELF.id, '2026-11-04T19:00:00-08:00')]
      : [];
  };
  const deps: AnnounceDeps = {
    announcements: async () => store,
    // Meetup's hostId filter: only the host's own events come back.
    ownUpcoming,
    eventDetails: vi.fn(async (id: string) => {
      const event = (await ownUpcoming(MEETUP_SELF.id)).find(
        (e) => e.id === id,
      );
      if (!event) {
        return undefined;
      }
      return {
        id,
        title: event.title,
        eventUrl: event.eventUrl,
        dateTime: event.dateTime,
        // The soon one was made this week, so Meetup still announces it.
        createdTime:
          id === SOON
            ? '2026-11-02T12:00:00-08:00'
            : '2026-10-01T12:00:00-07:00',
        rsvpState: 'RSVP',
        rsvpsClosed: false,
        hosts: event.hosts,
        ...options.details,
      };
    }),
    announce: vi.fn(options.announce ?? (async () => undefined)),
    alert: vi.fn().mockResolvedValue(true),
    now: () => now,
  };
  const recreatable = vi.fn(async (): Promise<Recreatable> => {
    if (options.recreatable instanceof Error) {
      throw options.recreatable;
    }
    return options.recreatable ?? { ok: true };
  });
  const recreate = vi.fn(async (): Promise<RecreateOutcome> => {
    if (options.recreate instanceof Error) {
      throw options.recreate;
    }
    if (options.recreate === 'never') {
      return new Promise<never>(() => undefined);
    }
    return options.recreate ?? { code: 'recreated', announce: 'sent' };
  });
  return {
    rows,
    store,
    deps,
    now,
    recreatable,
    recreate,
    readFails: options.readFails ?? false,
  };
}

async function setup(options: Parameters<typeof announceApp>[0] = {}) {
  const a = announceApp(options);
  const { deps } = makeHostDeps({
    pages: (router) =>
      registerHostPages(router, {
        events: {
          fetchGroupEvents: vi.fn(async (filter: { hostId?: string }) => {
            return filter.hostId
              ? [
                  ev(MINE),
                  ev(SOON, MEETUP_SELF.id, '2026-11-04T19:00:00-08:00'),
                ]
              : [ev(MINE), ev(THEIRS, '999')];
          }),
          now: () => a.now,
        },
        announce: {
          announce: (host, id, hooks) =>
            announceHostEvent(a.deps, host, id, hooks),
          announcements: async (ids) => {
            if (a.readFails) {
              throw new Error('pg down');
            }
            return new Map(
              ids.flatMap((id) => {
                const r = a.rows.get(id);
                return r ? [[id, r] as const] : [];
              }),
            );
          },
          cancel: (host, id) =>
            cancelHeldAnnouncement(a.deps, a.store.cancelHeld, host, id),
          recreatable: a.recreatable,
          recreate: a.recreate,
          deadlineMs: 50,
        },
      }),
  });
  const app = express();
  app.use('/host', createHostRouter(deps));
  const req = clientFor(await listen(app));
  const sid = await signInWithDiscord(req);
  const home = async (query = '') =>
    (await req.get(`/host${query}`).set('Cookie', sid)).text;
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await home())?.[1] ?? '';
  const postTo = (path: string, token = csrf) =>
    req
      .post(path)
      .set('Cookie', sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: token });
  const announce = (id: string, token = csrf) =>
    postTo(`/host/events/${id}/announce`, token);
  const cancel = (id: string) => postTo(`/host/events/${id}/announce/cancel`);
  const recreatePost = (id: string) => postTo(`/host/events/${id}/recreate`);
  return { ...a, req, sid, home, announce, cancel, recreatePost };
}

const noticeOf = (location: string | undefined) =>
  new URL(location ?? '', ORIGIN).searchParams.get('announce');

describe('Announce on the host home', () => {
  it('each own upcoming event has an Announce button, posting to its own path, with the guidelines', async () => {
    const { home } = await setup();
    const text = await home();
    expect(text).toContain(`action="/host/events/${MINE}/announce"`);
    expect(text).not.toContain(`/host/events/${THEIRS}/announce`);
    expect(text).toContain('It goes out once per event.');
    expect(text).toContain('Announcing: the guidelines');
    expect(text).toContain('Open RSVPs first.');
    expect(text).toContain('Announce 2–3 weeks ahead.');
  });

  it('announcing sends once; the button is then disabled and the event marked', async () => {
    const { announce, deps, home, req, sid } = await setup();
    const res = await announce(MINE);
    expect(res.status).toBe(303);
    expect(noticeOf(res.headers.location)).toBe('sent');
    expect(deps.announce).toHaveBeenCalledWith(MINE);
    const page = await req.get(res.headers.location ?? '').set('Cookie', sid);
    expect(page.text).toContain('Announced. Meetup is emailing the group');
    const text = await home();
    expect(text).toContain('<span class="badge ok">Announced</span>');
    expect(text).toMatch(
      /<button type="button" class="secondary" disabled>\s*Announced/,
    );
    expect(text).not.toContain(`action="/host/events/${MINE}/announce"`);
    // Sent again by hand (a stale tab): nothing goes out.
    expect(noticeOf((await announce(MINE)).headers.location)).toBe('already');
    expect(deps.announce).toHaveBeenCalledTimes(1);
  });

  it('a double click sends once', async () => {
    let release: (() => void) | undefined;
    const { announce, deps } = await setup({
      announce: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const one = Promise.resolve(announce(MINE));
    await vi.waitFor(() => {
      expect(deps.announce).toHaveBeenCalledTimes(1);
    });
    const two = await announce(MINE);
    expect(noticeOf(two.headers.location)).toBe('in-progress');
    // Meetup is still silent past the page's deadline (50 ms here).
    expect(noticeOf((await one).headers.location)).toBe('slow');
    release?.();
    expect(deps.announce).toHaveBeenCalledTimes(1);
  });

  it('a slow events read that ends in "not yours" never says "still waiting"', async () => {
    const { announce, deps } = await setup({ ownUpcomingDelayMs: 150 });
    const res = await announce(THEIRS);
    expect(noticeOf(res.headers.location)).toBe('not-yours');
    expect(deps.announce).not.toHaveBeenCalled();
  });

  it('someone else’s event, or a bad id: refused, nothing claimed or sent', async () => {
    const { announce, deps, store } = await setup();
    expect(noticeOf((await announce(THEIRS)).headers.location)).toBe(
      'not-yours',
    );
    expect(noticeOf((await announce('abc')).headers.location)).toBe(
      'not-yours',
    );
    expect(store.claim).not.toHaveBeenCalled();
    expect(deps.announce).not.toHaveBeenCalled();
  });

  it('without the CSRF token: 403 and nothing sent', async () => {
    const { announce, cancel, recreatePost, deps, recreate } = await setup();
    expect((await announce(MINE, 'wrong')).status).toBe(403);
    expect(deps.announce).not.toHaveBeenCalled();
    // The other two POSTs sit behind the same guard.
    expect(
      (await cancel(MINE).set('Origin', 'https://evil.example')).status,
    ).toBe(403);
    expect(
      (await recreatePost(MINE).set('Origin', 'https://evil.example')).status,
    ).toBe(403);
    expect(recreate).not.toHaveBeenCalled();
  });

  it('a refused announcement says so and offers to try again', async () => {
    const { announce, home } = await setup({
      announce: async () => {
        const { MeetupPayloadError } =
          await import('../../../src/lib/client/meetup/payloadErrors.js');
        throw new MeetupPayloadError('announceEvent', [
          { code: 'NOT_ALLOWED', field: null, message: 'no' },
        ]);
      },
    });
    expect(noticeOf((await announce(MINE)).headers.location)).toBe('failed');
    expect(await home()).toMatch(/Try announcing again/);
  });

  it('an unconfirmed one offers to try again', async () => {
    const { announce, home, deps } = await setup({
      announce: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(noticeOf((await announce(MINE)).headers.location)).toBe(
      'unconfirmed',
    );
    const text = await home();
    expect(text).toContain('Announcement not confirmed');
    expect(text).toMatch(/Try announcing again/);
    vi.mocked(deps.announce).mockResolvedValueOnce(undefined);
    expect(noticeOf((await announce(MINE)).headers.location)).toBe('sent');
  });

  it('a send cut off by a restart (sending for 2+ minutes) is not confirmed and retryable', async () => {
    const { rows, home, deps, now } = await setup();
    rows.set(
      MINE,
      row(MINE, 'sending', {
        requestedAt: new Date(now.getTime() - 3 * 60 * 1000),
      }),
    );
    const text = await home();
    expect(text).toContain('Announcement not confirmed');
    expect(text).toContain(`action="/host/events/${MINE}/announce"`);
    // A fresh one is still "Announcing…", disabled.
    rows.set(MINE, row(MINE, 'sending', { requestedAt: now }));
    expect(await home()).toMatch(/disabled>\s*Announcing…/);
    expect(deps.announce).not.toHaveBeenCalled();
  });

  it('a store outage on the home page still shows the page and the button', async () => {
    const { home } = await setup({ readFails: true });
    const text = await home();
    expect(text).toContain('Your upcoming events');
    expect(text).toContain(`action="/host/events/${MINE}/announce"`);
  });

  it('an unknown ?announce= code shows nothing', async () => {
    const { req, sid } = await setup();
    const res = await req.get('/host?announce=<script>').set('Cookie', sid);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('&lt;script&gt;');
  });
});

describe('the hold', () => {
  it('a work-hours request is scheduled: the time is shown and it can be cancelled', async () => {
    const { announce, cancel, home, deps, rows } = await setup({ now: NOW });
    expect(noticeOf((await announce(MINE)).headers.location)).toBe('scheduled');
    expect(deps.announce).not.toHaveBeenCalled();
    let text = await home('?announce=scheduled');
    expect(text).toContain('Scheduled. The time is by the event below');
    expect(text).toMatch(/Announcement scheduled for\s+Tue, Nov 3 at 4:00 PM/);
    expect(text).toContain(`action="/host/events/${MINE}/announce/cancel"`);
    expect(text).toContain('Cancel the announcement');
    expect(text).not.toContain(`action="/host/events/${MINE}/announce"`);
    expect(noticeOf((await cancel(MINE)).headers.location)).toBe('cancelled');
    expect(rows.get(MINE)?.status).toBe('cancelled');
    text = await home('?announce=cancelled');
    expect(text).toContain('The scheduled announcement was cancelled');
    expect(text).toContain(`action="/host/events/${MINE}/announce"`);
    // Cancelling again, or someone else's: says so, changes nothing.
    expect(noticeOf((await cancel(MINE)).headers.location)).toBe('not-held');
    expect(noticeOf((await cancel(THEIRS)).headers.location)).toBe('not-yours');
  });

  it('an event within 3 days goes out at once even in work hours', async () => {
    const { announce, deps } = await setup({ now: NOW });
    expect(noticeOf((await announce(SOON)).headers.location)).toBe('sent');
    expect(deps.announce).toHaveBeenCalledWith(SOON);
  });

  it('more than 3 weeks out: a warning by the button, which still works', async () => {
    const { home, announce } = await setup({
      now: new Date('2026-10-10T03:00:00Z'),
    });
    const text = await home();
    expect(text).toContain('More than 3 weeks away');
    expect(text).toContain(`action="/host/events/${MINE}/announce"`);
    expect(noticeOf((await announce(MINE)).headers.location)).toBe('sent');
  });
});

describe('pre-checks on the page', () => {
  it('RSVPs not open: refused with the advice, nothing claimed', async () => {
    const { announce, home, store } = await setup({
      details: { rsvpState: 'NOT_OPEN_YET' },
    });
    const res = await announce(MINE);
    expect(noticeOf(res.headers.location)).toBe('rsvps-closed');
    expect(store.claim).not.toHaveBeenCalled();
    expect(await home('?announce=rsvps-closed')).toContain(
      'Open them on Meetup first',
    );
  });

  it('too late: the notice names the event and offers Recreate and announce when it may', async () => {
    const { announce, home, recreatable } = await setup({
      now: new Date('2026-11-08T03:00:00Z'),
    });
    const res = await announce(MINE);
    expect(res.headers.location).toBe(`/host?announce=too-late&event=${MINE}`);
    const text = await home(`?announce=too-late&event=${MINE}`);
    expect(text).toContain('Meetup will not announce an event within 7 days');
    expect(text).toContain(`action="/host/events/${MINE}/recreate"`);
    expect(text).toContain('Recreate and announce');
    expect(recreatable).toHaveBeenCalledWith(
      expect.objectContaining({ meetupMemberId: MEETUP_SELF.id }),
      MINE,
    );
  });

  it('too late with other RSVPs: says why it is not offered, with no button', async () => {
    const { home } = await setup({
      recreatable: { ok: false, reason: 'has-rsvps' },
    });
    const text = await home(`?announce=too-late&event=${MINE}`);
    expect(text).toContain('someone other than the hosts has already RSVPed');
    expect(text).not.toContain(`action="/host/events/${MINE}/recreate"`);
  });

  it('the recreatable check failing shows a reload note, and a stranger’s event id shows nothing', async () => {
    const { home } = await setup({ recreatable: new Error('meetup down') });
    expect(await home(`?announce=too-late&event=${MINE}`)).toContain(
      'could not be checked just now',
    );
    expect(await home(`?announce=too-late&event=${THEIRS}`)).not.toContain(
      'Meetup will not announce this event any more',
    );
  });
});

describe('Recreate and announce', () => {
  it('runs the recreate and reports its outcome', async () => {
    const { recreatePost, home } = await setup();
    const res = await recreatePost(MINE);
    expect(res.status).toBe(303);
    expect(noticeOf(res.headers.location)).toBe('recreated');
    expect(await home('?announce=recreated')).toContain(
      'your event was recreated',
    );
    for (const code of ['recreated-scheduled', 'recreated-old-kept'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const text = await home(`?announce=${code}`);
      expect(text).toContain('note info');
    }
    expect(await home('?announce=recreated-scheduled')).toContain(
      'goes out at the time shown',
    );
    expect(await home('?announce=recreated-old-kept')).toContain(
      'asked to cancel it',
    );
  });

  it('every refusal has its own notice', async () => {
    for (const code of [
      'has-rsvps',
      'already-recreated',
      'announce-failed',
      'cancel-failed',
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      const { recreatePost, home } = await setup({ recreate: { code } });
      // eslint-disable-next-line no-await-in-loop
      expect(noticeOf((await recreatePost(MINE)).headers.location)).toBe(code);
      // eslint-disable-next-line no-await-in-loop
      const text = await home(`?announce=${code}`);
      expect(text).toContain('note attn');
    }
  });

  it('a slow recreate says to reload; a failure here says nothing was sent', async () => {
    const slow = await setup({ recreate: 'never' });
    expect(noticeOf((await slow.recreatePost(MINE)).headers.location)).toBe(
      'slow',
    );
    const broken = await setup({ recreate: new Error('pg down') });
    expect(noticeOf((await broken.recreatePost(MINE)).headers.location)).toBe(
      'error',
    );
    expect(noticeOf((await broken.recreatePost('abc')).headers.location)).toBe(
      'not-yours',
    );
  });
});

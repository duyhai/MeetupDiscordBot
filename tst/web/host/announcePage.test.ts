import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AnnounceDeps,
  announceHostEvent,
} from '../../../src/lib/hosts/announceEvent.js';
import { HostEvent } from '../../../src/lib/hosts/hostEvents.js';
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

const NOW = new Date('2026-11-03T18:00:00Z');
const MINE = '311111111';
const THEIRS = '322222222';

const ev = (id: string, hostId = MEETUP_SELF.id): HostEvent => ({
  id,
  title: `Event ${id}`,
  dateTime: '2026-11-10T19:00:00-08:00',
  eventUrl: `https://www.meetup.com/g/events/${id}/`,
  type: 'social',
  hosts: [{ id: hostId, name: 'Ann' }],
});

/** The real announceHostEvent on an in-memory table with Postgres's claim. */
function announceApp(
  options: {
    announce?: () => Promise<void>;
    readFails?: boolean;
    ownUpcomingDelayMs?: number;
  } = {},
) {
  const rows = new Map<string, Announcement>();
  const store = {
    claim: vi.fn(async (id: string, by: string) => {
      const current = rows.get(id);
      if (
        current === undefined ||
        current.status === 'failed' ||
        current.status === 'unknown'
      ) {
        rows.set(id, {
          meetupEventId: id,
          requestedBy: by,
          status: 'sending',
          failure: null,
          requestedAt: NOW,
          completedAt: null,
        });
        return { claimed: true as const };
      }
      return { claimed: false as const, current };
    }),
    finish: vi.fn(
      async (
        id: string,
        status: Announcement['status'],
        failure: string | null = null,
      ) => {
        const row = rows.get(id);
        if (row?.status === 'sending') {
          rows.set(id, { ...row, status, failure });
        }
      },
    ),
  };
  const deps: AnnounceDeps = {
    announcements: async () => store,
    // Meetup's hostId filter: only the host's own events come back.
    ownUpcoming: async (memberId) => {
      await new Promise((resolve) => {
        setTimeout(resolve, options.ownUpcomingDelayMs ?? 0);
      });
      return memberId === MEETUP_SELF.id ? [ev(MINE)] : [];
    },
    announce: vi.fn(options.announce ?? (async () => undefined)),
    alert: vi.fn().mockResolvedValue(true),
  };
  return { rows, store, deps, readFails: options.readFails ?? false };
}

async function setup(options: Parameters<typeof announceApp>[0] = {}) {
  const a = announceApp(options);
  const { deps } = makeHostDeps({
    pages: (router) =>
      registerHostPages(router, {
        events: {
          fetchGroupEvents: vi.fn(async (filter: { hostId?: string }) => {
            return filter.hostId ? [ev(MINE)] : [ev(MINE), ev(THEIRS, '999')];
          }),
          now: () => NOW,
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
                const row = a.rows.get(id);
                return row ? [[id, row] as const] : [];
              }),
            );
          },
          deadlineMs: 50,
        },
      }),
  });
  const app = express();
  app.use('/host', createHostRouter(deps));
  const req = clientFor(await listen(app));
  const sid = await signInWithDiscord(req);
  const home = async () => (await req.get('/host').set('Cookie', sid)).text;
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await home())?.[1] ?? '';
  const announce = (id: string, token = csrf) =>
    req
      .post(`/host/events/${id}/announce`)
      .set('Cookie', sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: token });
  return { ...a, req, sid, home, announce };
}

const noticeOf = (location: string | undefined) =>
  new URL(location ?? '', ORIGIN).searchParams.get('announce');

describe('Announce on the host home', () => {
  it('each own upcoming event has an Announce button, posting to its own path', async () => {
    const { home } = await setup();
    const text = await home();
    expect(text).toContain(`action="/host/events/${MINE}/announce"`);
    expect(text).not.toContain(`/host/events/${THEIRS}/announce`);
    expect(text).toContain('It goes out once per event.');
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
    const { announce, deps } = await setup();
    expect((await announce(MINE, 'wrong')).status).toBe(403);
    expect(deps.announce).not.toHaveBeenCalled();
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
    const { rows, home, deps } = await setup();
    rows.set(MINE, {
      meetupEventId: MINE,
      requestedBy: MEETUP_SELF.id,
      status: 'sending',
      failure: null,
      requestedAt: new Date(NOW.getTime() - 3 * 60 * 1000),
      completedAt: null,
    });
    const text = await home();
    expect(text).toContain('Announcement not confirmed');
    expect(text).toContain(`action="/host/events/${MINE}/announce"`);
    // A fresh one is still "Announcing…", disabled.
    rows.set(MINE, { ...rows.get(MINE), requestedAt: NOW });
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

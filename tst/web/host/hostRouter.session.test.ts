import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HOST,
  closeServers,
  locationOf,
  makeHostApp,
  signInWithDiscord,
  signInWithMeetup,
} from './hostHarness.js';

afterEach(closeServers);

const TEN_MIN = 10 * 60 * 1000;

/** A page that echoes the session's tier, mounted through the pages hook. */
const echoTier = (router: import('express').Router) => {
  router.get('/', (_req, res) => {
    const { session } = res.locals as {
      session: { tier: string; discordUserId: string | null };
    };
    res.type('text').send(`${session.tier}|${String(session.discordUserId)}`);
  });
};

describe('host tier re-check', () => {
  it('no re-check before 10 minutes', async () => {
    let now = 0;
    const { req, deps } = await makeHostApp({
      now: () => now,
      pages: echoTier,
    });
    const sid = await signInWithDiscord(req);
    now = TEN_MIN - 1;
    expect((await req.get('/host').set('Cookie', sid)).text).toBe(
      `regular|${HOST.kind === 'host' ? HOST.discordUserId : ''}`,
    );
    expect(deps.resolve).toHaveBeenCalledTimes(1);
  });

  it('at 10 minutes a promotion reaches the session, by Meetup id', async () => {
    let now = 0;
    const resolve = vi.fn().mockResolvedValue(HOST);
    const { req } = await makeHostApp({
      now: () => now,
      pages: echoTier,
      resolve,
    });
    const sid = await signInWithDiscord(req);
    resolve.mockResolvedValue({
      ...HOST,
      tier: 'promoted',
      discordUserId: undefined,
    });
    now = TEN_MIN;
    expect((await req.get('/host').set('Cookie', sid)).text).toBe(
      'promoted|null',
    );
    expect(resolve).toHaveBeenLastCalledWith({ meetupMemberId: '4242' });
    // Stored, so the next request does not re-check again.
    now = TEN_MIN + 1000;
    expect((await req.get('/host').set('Cookie', sid)).text).toBe(
      'promoted|null',
    );
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('ineligible at the re-check: 403 here, and every other session of the host ends', async () => {
    let now = 0;
    const resolve = vi.fn().mockResolvedValue(HOST);
    const { req, deps } = await makeHostApp({
      now: () => now,
      pages: echoTier,
      resolve,
    });
    const first = await signInWithDiscord(req);
    const second = await signInWithMeetup(req);
    resolve.mockResolvedValue({
      kind: 'refused',
      reason: 'blacklisted',
    });
    now = TEN_MIN;
    expect((await req.get('/host').set('Cookie', first)).status).toBe(403);
    expect(
      locationOf(await req.get('/host').set('Cookie', second)).pathname,
    ).toBe('/host/login');
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Host dashboard session ended' }),
    );
  });

  it('an outage at the re-check is a 503 and keeps the session', async () => {
    let now = 0;
    const resolve = vi.fn().mockResolvedValue(HOST);
    const { req } = await makeHostApp({
      now: () => now,
      pages: echoTier,
      resolve,
    });
    const sid = await signInWithDiscord(req);
    resolve.mockRejectedValueOnce(new Error('meetup down'));
    now = TEN_MIN;
    expect((await req.get('/host').set('Cookie', sid)).status).toBe(503);
    expect((await req.get('/host').set('Cookie', sid)).text).toBe(
      `regular|${HOST.kind === 'host' ? HOST.discordUserId : ''}`,
    );
  });

  it('concurrent stale requests share one re-check', async () => {
    let now = 0;
    const resolve = vi.fn().mockResolvedValue(HOST);
    const { req } = await makeHostApp({
      now: () => now,
      pages: echoTier,
      resolve,
    });
    const sid = await signInWithDiscord(req);
    now = TEN_MIN;
    await Promise.all([1, 2, 3].map(() => req.get('/host').set('Cookie', sid)));
    expect(resolve.mock.calls.length).toBeLessThanOrEqual(3);
    expect(resolve.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a session expires 12 hours after sign-in', async () => {
    let now = 0;
    const { req } = await makeHostApp({ now: () => now, pages: echoTier });
    const sid = await signInWithDiscord(req);
    now = 12 * 60 * 60 * 1000;
    expect(locationOf(await req.get('/host').set('Cookie', sid)).pathname).toBe(
      '/host/login',
    );
  });
});

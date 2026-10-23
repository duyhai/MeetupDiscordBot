import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BAN_PHOTO_BODY_LIMIT,
  BAN_PHOTO_BODY_PATH,
} from '../../src/web/dashboardRouter.js';
import { signSessionId } from '../../src/web/session.js';
import {
  ORIGIN,
  SECRET,
  closeServers,
  makeApp,
  signIn,
} from './dashboardHarness.js';

afterEach(() => closeServers());

const KB = 1024;

/** Protected test routes that answer with the length of the parsed photo field. */
async function setup() {
  const reached = vi.fn();
  const echo: express.RequestHandler = (req, res) => {
    reached(req.path);
    const body = req.body as Record<string, unknown> | undefined;
    const photo = body?.photo;
    res
      .status(200)
      .type('text')
      .send(String(typeof photo === 'string' ? photo.length : -1));
  };
  const { req } = await makeApp({
    protectedRoutes: (r) => {
      r.post('/bans/:id/photo', echo);
      r.post('/bans/:id/lift', echo);
      r.post('/Bans/:id/photo', echo);
    },
  });
  const cookie = await signIn(req);
  const home = await req.get('/dashboard').set('Cookie', cookie);
  const token = /name="_csrf" value="([^"]+)"/.exec(home.text)?.[1] ?? '';
  const postWithToken = (
    path: string,
    size: number,
    csrf: string,
    withSession = true,
  ) => {
    const request = req
      .post(path)
      .set('Origin', ORIGIN)
      .type('form')
      .send(`_csrf=${encodeURIComponent(csrf)}&photo=${'A'.repeat(size * KB)}`);
    return withSession ? request.set('Cookie', cookie) : request;
  };
  const post = (path: string, size: number, withSession = true) =>
    postWithToken(path, size, token, withSession);
  const postWithCookie = (path: string, size: number, sent: string) =>
    req
      .post(path)
      .set('Origin', ORIGIN)
      .set('Cookie', sent)
      .type('form')
      .send(
        `_csrf=${encodeURIComponent(token)}&photo=${'A'.repeat(size * KB)}`,
      );
  return { cookie, post, postWithCookie, postWithToken, reached };
}

describe('the ban photo body limit', () => {
  it('is 220kb on POST /bans/:id/photo only', () => {
    expect(BAN_PHOTO_BODY_LIMIT).toBe('220kb');
    expect(BAN_PHOTO_BODY_PATH.test('/bans/1/photo')).toBe(true);
    expect(BAN_PHOTO_BODY_PATH.test('/bans/123456789/photo/')).toBe(true);
    for (const path of [
      '/bans/0/photo',
      '/bans/01/photo',
      '/bans/1234567890/photo',
      '/Bans/1/photo',
      '/bans/1/PHOTO',
      '/bans/1/photo/x',
      '/bans/1/lift',
      '/x/bans/1/photo',
    ]) {
      expect(BAN_PHOTO_BODY_PATH.test(path)).toBe(false);
    }
  });

  it('a 210 KB form to /bans/1/photo reaches the route; to /bans/1/photo/ as well', async () => {
    const { post } = await setup();
    for (const path of [
      '/dashboard/bans/1/photo',
      '/dashboard/bans/1/photo/',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await post(path, 210);
      expect(res.status).toBe(200);
      expect(res.text).toBe(String(210 * KB));
    }
  });

  it('a 230 KB form to /bans/1/photo is the 400 page', async () => {
    const { post, reached } = await setup();
    const res = await post('/dashboard/bans/1/photo', 230);
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('too large');
    expect(reached).not.toHaveBeenCalled();
  });

  it('a 40 KB form to /bans/1/lift is the 400 page; a 20 KB one reaches it', async () => {
    const { post, reached } = await setup();
    expect((await post('/dashboard/bans/1/lift', 40)).status).toBe(400);
    expect(reached).not.toHaveBeenCalled();
    const small = await post('/dashboard/bans/1/lift', 20);
    expect(small.status).toBe(200);
    expect(small.text).toBe(String(20 * KB));
  });

  it('a 40 KB form to /Bans/1/photo is the 400 page', async () => {
    const { post, reached } = await setup();
    expect((await post('/dashboard/Bans/1/photo', 40)).status).toBe(400);
    expect(reached).not.toHaveBeenCalled();
  });

  it('a signed-out 100 KB post to /bans/1/photo is the 400 page: 32kb applies without a session cookie', async () => {
    const { post, reached } = await setup();
    const res = await post('/dashboard/bans/1/photo', 100, false);
    expect(res.status).toBe(400);
    expect(reached).not.toHaveBeenCalled();
  });

  it('a tampered session cookie gets 32kb: a 100 KB post is the 400 page', async () => {
    const { cookie, postWithCookie, reached } = await setup();
    const last = cookie.at(-1) === 'A' ? 'B' : 'A';
    const tampered = `${cookie.slice(0, -1)}${last}`;
    const res = await postWithCookie('/dashboard/bans/1/photo', 100, tampered);
    expect(res.status).toBe(400);
    expect(reached).not.toHaveBeenCalled();
    // The same body with the real cookie is accepted.
    const ok = await postWithCookie('/dashboard/bans/1/photo', 100, cookie);
    expect(ok.status).toBe(200);
  });

  it('a validly signed cookie with no live session gets 220kb, then the gate refuses it 403', async () => {
    const { postWithCookie, reached } = await setup();
    const sid = 'x'.repeat(43);
    const forged = `dash_sid=${signSessionId(sid, SECRET)}`;
    const res = await postWithCookie('/dashboard/bans/1/photo', 210, forged);
    expect(res.status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });

  it('a signed-out 20 KB post to /bans/1/photo is refused 403 and reaches no route', async () => {
    const { post, reached } = await setup();
    const res = await post('/dashboard/bans/1/photo', 20, false);
    expect(res.status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });

  it('a path that only starts like the photo path keeps 32kb', async () => {
    const { post } = await setup();
    expect((await post('/dashboard/bans/1/photo/x', 40)).status).toBe(400);
  });

  it('the parser runs before the CSRF guard: the token comes from the 210 KB body, and a wrong one is 403', async () => {
    const { post, postWithToken, reached } = await setup();
    expect((await post('/dashboard/bans/1/photo', 210)).status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(1);
    const res = await postWithToken('/dashboard/bans/1/photo', 210, 'wrong');
    expect(res.status).toBe(403);
    expect(reached).toHaveBeenCalledTimes(1);
  });
});

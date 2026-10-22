import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { BanRow, BanState } from '../../../src/lib/bans/types.js';
import {
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from '../../../src/web/routes/dashboardPages.js';
import { registerBanRoutes } from '../../../src/web/routes/bans.js';
import { clientFor } from '../../setup/loopbackServer.js';
import { closeServers, listen, makeApp, signIn } from '../dashboardHarness.js';
import {
  PAGE_NOW,
  WEBP_BYTES,
  banRow,
  fakeBans,
  fakeOrganizerDeps,
  fakePageDeps,
  fakeSuspensions,
  suspensionRow,
} from './pageFakes.js';

afterEach(closeServers);

const TAB = '/dashboard/suspensions?state=banned';
const UPLOADER = '223456789012345678';
const LIFTER = '323456789012345678';

async function setup(
  rows: Partial<Record<BanState, BanRow[]>> = { active: [banRow()] },
  photos: Record<number, Buffer> = {},
  pages: Partial<DashboardPageDeps> = {},
) {
  const bans = fakeBans(rows, photos);
  const suspensions = fakeSuspensions({
    active: [suspensionRow()],
    past: [],
    voided: [],
  });
  const { req } = await makeApp({
    now: () => PAGE_NOW.getTime(),
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({
          bans: async () => bans,
          suspensions: async () => suspensions,
          ...pages,
        }),
      }),
  });
  const cookie = await signIn(req);
  const get = (path: string) => req.get(path).set('Cookie', cookie);
  return { bans, suspensions, get, req };
}

/** Page text with tags dropped and whitespace collapsed, for sentence checks. */
const words = (body: string) =>
  body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tbody = (body: string) =>
  /<tbody>([\s\S]*?)<\/tbody>/.exec(body)?.[1] ?? '';

describe('Banned tab', () => {
  it('the Suspensions tabs include Banned with the active count', async () => {
    const { get } = await setup({
      active: [banRow(), banRow()],
      lifted: [banRow({ liftedAt: new Date('2026-10-01T17:00:00Z') })],
    });
    const res = await get('/dashboard/suspensions');
    expect(res.status).toBe(200);
    expect(words(res.text)).toContain('Banned (2)');
    expect(res.text).toContain('href="/dashboard/suspensions?state=banned"');
  });

  it('the Banned tab shows photo, member link, id, date or Date unknown, recorder, notes and photo source', async () => {
    const uploaded = banRow({
      id: 11,
      memberId: '424242',
      memberName: 'Ann Banned',
      notes: 'Harassed members at two events',
      hasPhoto: true,
      photoSource: 'upload',
      photoUpdatedAt: new Date('2026-10-02T17:00:00Z'),
      photoUpdatedBy: UPLOADER,
    });
    const profile = banRow({
      id: 12,
      memberId: '515151',
      memberName: 'Bo Banned',
      bannedOn: null,
      hasPhoto: true,
      photoSource: 'profile',
      photoUpdatedAt: new Date('2026-10-03T17:00:00Z'),
    });
    const { get, bans } = await setup({ active: [uploaded, profile] });
    const res = await get(TAB);
    expect(res.status).toBe(200);
    expect(bans.listPage).toHaveBeenCalledWith({
      state: 'active',
      offset: 0,
      limit: 50,
    });
    const body = tbody(res.text);
    const img = /<img[^>]*src="\/dashboard\/bans\/11\/photo"[^>]*>/.exec(
      body,
    )?.[0];
    expect(img).toBeDefined();
    for (const attr of [
      'class="ban-photo"',
      'width="96"',
      'height="96"',
      'alt="Photo of the banned member"',
      'loading="lazy"',
    ]) {
      expect(img).toContain(attr);
    }
    expect(body).toContain('src="/dashboard/bans/12/photo"');
    expect(body).toContain('href="https://www.meetup.com/members/424242/"');
    expect(body).toContain('<bdi>Ann Banned</bdi>');
    const text = words(body);
    expect(text).toContain('(424242)');
    expect(text).toContain('2026-09-15');
    expect(text).toContain('Date unknown');
    expect(text).toContain('Harassed members at two events');
    expect(text).toContain('Uploaded by staff member on Oct 2, 2026');
    expect(text).toContain('From their profile on Oct 3, 2026');
    expect(body).toContain(`href="https://discord.com/users/${UPLOADER}"`);
    for (const label of [
      'Photo',
      'Member',
      'Banned',
      'Recorded by',
      'Notes',
      'Photo from',
    ]) {
      expect(body).toContain(`data-label="${label}"`);
    }
    expect(body).not.toContain('data-label="Lifted"');
    expect(words(res.text)).toContain('Active (2)');
    expect(words(res.text)).toContain('Lifted (0)');
  });

  it('a ban without a photo says No photo and has no img', async () => {
    const { get } = await setup({ active: [banRow({ hasPhoto: false })] });
    const res = await get(TAB);
    const body = tbody(res.text);
    expect(words(body)).toContain('No photo');
    expect(body).not.toContain('<img');
  });

  it('a member id that is not all digits gets no Meetup link', async () => {
    const { get } = await setup({
      active: [banRow({ memberId: '12a4', memberName: '' })],
    });
    const res = await get(TAB);
    expect(res.status).toBe(200);
    const body = tbody(res.text);
    expect(body).not.toContain('meetup.com');
    expect(words(body)).toContain('12a4');
    expect(words(body)).toContain('(12a4)');
  });

  it('member names and notes are escaped inside bdi', async () => {
    const { get } = await setup({
      active: [
        banRow({
          memberName: '<script>alert(1)</script>',
          notes: '<b>bold</b>',
        }),
      ],
    });
    const res = await get(TAB);
    const body = tbody(res.text);
    expect(body).toContain('<bdi>&lt;script&gt;alert(1)&lt;/script&gt;</bdi>');
    expect(body).toContain('<bdi>&lt;b&gt;bold&lt;/b&gt;</bdi>');
    expect(body).not.toContain('<script>');
  });

  it('lifted bans show who lifted, when and why, and keep the photo', async () => {
    const lifted = banRow({
      id: 21,
      hasPhoto: true,
      photoSource: 'profile',
      photoUpdatedAt: new Date('2026-09-20T17:00:00Z'),
      liftedAt: new Date('2026-10-04T17:00:00Z'),
      liftedBy: LIFTER,
      liftReason: 'Appeal granted',
    });
    const { get, bans } = await setup({ active: [banRow()], lifted: [lifted] });
    const res = await get(`${TAB}&show=lifted`);
    expect(res.status).toBe(200);
    expect(bans.listPage).toHaveBeenCalledWith({
      state: 'lifted',
      offset: 0,
      limit: 50,
    });
    const body = tbody(res.text);
    expect(body).toContain('src="/dashboard/bans/21/photo"');
    expect(body).toContain('data-label="Lifted"');
    expect(body).toContain('data-label="Lifted by"');
    expect(body).toContain('data-label="Reason"');
    expect(body).toContain(`href="https://discord.com/users/${LIFTER}"`);
    expect(words(body)).toContain('Oct 4, 2026');
    expect(body).toContain('<bdi>Appeal granted</bdi>');
    expect(res.text).toContain(
      'href="/dashboard/suspensions?state=banned&amp;show=active"',
    );
  });

  it('an unknown show value falls back to active', async () => {
    const { get, bans } = await setup();
    const res = await get(`${TAB}&show=everything`);
    expect(res.status).toBe(200);
    expect(bans.listPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'active' }),
    );
  });

  it('the Banned tab never reads the suspension list', async () => {
    const { get, suspensions } = await setup();
    const res = await get(TAB);
    expect(res.status).toBe(200);
    expect(suspensions.listPage).not.toHaveBeenCalled();
    expect(suspensions.countByState).toHaveBeenCalled();
    expect(words(res.text)).toContain('Active (1)');
  });

  it('a malformed ban row renders 503, not 500', async () => {
    for (const bad of [
      { ...banRow(), id: 'x' },
      { ...banRow(), memberId: 7 },
      { ...banRow(), createdAt: 'yesterday' },
      { ...banRow(), hasPhoto: 'yes' },
      null,
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one app at a time
      const { get } = await setup({ active: [bad as unknown as BanRow] });
      // eslint-disable-next-line no-await-in-loop
      const res = await get(TAB);
      expect(res.status).toBe(503);
    }
  });

  it('a failing bans read is the 503 page', async () => {
    const { get } = await setup(undefined, undefined, {
      bans: () => Promise.reject(new Error('down')),
    });
    expect((await get(TAB)).status).toBe(503);
  });
});

describe('ban photo route', () => {
  it('the photo route serves the sniffed type with no-store, nosniff and same-origin', async () => {
    const { get, bans } = await setup(
      { active: [banRow({ id: 5, hasPhoto: true })] },
      { 5: WEBP_BYTES },
    );
    const res = await get('/dashboard/bans/5/photo');
    expect(res.status).toBe(200);
    expect(bans.getPhoto).toHaveBeenCalledWith(5);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['content-length']).toBe(String(WEBP_BYTES.length));
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it("the photo route 404s for id 0, 'abc', a ban without a photo, and bytes that sniff as nothing", async () => {
    const htmlBytes = Buffer.from('<html>');
    const { get, bans } = await setup(
      { active: [banRow({ id: 5 }), banRow({ id: 6 })] },
      { 6: htmlBytes },
    );
    for (const path of ['0', 'abc', '01', '1234567890', '5', '6']) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await get(`/dashboard/bans/${path}/photo`);
      expect(res.status, path).toBe(404);
      expect(res.text, path).not.toContain('<html>\n');
      expect(res.headers['content-type'], path).toMatch(/^text\/html/);
    }
    expect(bans.getPhoto.mock.calls.map(([id]) => id)).toEqual([5, 6]);
  });

  it('the photo route sets its own headers, without the router base headers', async () => {
    const bans = fakeBans({ active: [] }, { 5: WEBP_BYTES });
    const router = express.Router();
    registerBanRoutes(router, { now: () => PAGE_NOW, bans: async () => bans });
    const app = express();
    app.use('/dashboard', router);
    const res = await clientFor(await listen(app)).get(
      '/dashboard/bans/5/photo',
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['content-disposition']).toBe('inline');
  });

  it('the photo route needs a session', async () => {
    const { req } = await setup(
      { active: [banRow({ id: 5, hasPhoto: true })] },
      { 5: WEBP_BYTES },
    );
    const res = await req.get('/dashboard/bans/5/photo');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/login/);
  });
});

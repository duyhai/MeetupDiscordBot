import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BanRow, BanState } from '../../../src/lib/bans/types.js';
import {
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from '../../../src/web/routes/dashboardPages.js';
import { liftBan } from '../../../src/lib/bans/service.js';
import {
  BAN_REQUEST_DEADLINE_MS,
  BAN_RESULT_MESSAGES,
  registerBanRoutes,
} from '../../../src/web/routes/bans.js';
import { LEADERSHIP_CHECK_DEADLINE_MS } from '../../../src/web/routes/workspaceActions.js';
import { clientFor } from '../../setup/loopbackServer.js';
import {
  Client,
  ORIGIN,
  USER,
  closeServers,
  listen,
  makeApp,
  signIn,
} from '../dashboardHarness.js';
import {
  PAGE_NOW,
  WEBP_BYTES,
  banRow,
  fakeBanActions,
  fakeBans,
  fakeOrganizerDeps,
  fakePageDeps,
  fakeSuspensions,
  suspensionRow,
} from './pageFakes.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  return closeServers();
});

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

  it('a failing ban count leaves the suspension tabs up, labelled Banned with no count', async () => {
    const { get } = await setup(undefined, undefined, {
      bans: () => Promise.reject(new Error('down')),
    });
    const res = await get('/dashboard/suspensions');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(
      /<a href="\/dashboard\/suspensions\?state=banned">Banned<\/a>/,
    );
    expect(words(res.text)).not.toMatch(/Banned \(/);
    expect(words(res.text)).toContain('Active (1)');
  });

  it('a failing suspension count leaves the Banned tab up, with no counts on the other tabs', async () => {
    const { get, suspensions } = await setup({
      active: [banRow({ memberName: 'Still Shown' })],
    });
    suspensions.countByState.mockRejectedValue(new Error('down'));
    const res = await get(TAB);
    expect(res.status).toBe(200);
    expect(tbody(res.text)).toContain('<bdi>Still Shown</bdi>');
    expect(res.text).toMatch(
      /<a href="\/dashboard\/suspensions\?state=active">Active<\/a>/,
    );
    expect(words(res.text)).not.toMatch(/Past \(|Voided \(/);
    expect(words(res.text)).toContain('Banned (1)');
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
    const htmlBytes = Buffer.from('<html>BAN-BYTES-7f3a');
    const { get, bans } = await setup(
      { active: [banRow({ id: 5 }), banRow({ id: 6 })] },
      { 6: htmlBytes },
    );
    for (const path of ['0', 'abc', '01', '1234567890', '5', '6']) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await get(`/dashboard/bans/${path}/photo`);
      expect(res.status, path).toBe(404);
      expect(res.text, path).not.toContain('BAN-BYTES-7f3a');
      expect(res.headers['content-type'], path).toMatch(/^text\/html/);
    }
    expect(bans.getPhoto.mock.calls.map(([id]) => id)).toEqual([5, 6]);
  });

  it('the photo route sets its own headers, without the router base headers', async () => {
    const bans = fakeBans({ active: [] }, { 5: WEBP_BYTES });
    const router = express.Router();
    registerBanRoutes(router, fakePageDeps({ bans: async () => bans }));
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

async function tokenOf(req: Client, cookie: string): Promise<string> {
  const home = await req.get('/dashboard').set('Cookie', cookie);
  const match = /name="_csrf" value="([^"]+)"/.exec(home.text);
  if (!match) {
    throw new Error('home page has no CSRF field');
  }
  return match[1];
}

const never = <T>() => new Promise<T>(() => undefined);

/** Only the timers the deadlines use: the loopback server's own I/O keeps running. */
const fakeTimers = () =>
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

async function postSetup(
  options: {
    leader?: boolean | Error;
    actions?: Partial<DashboardPageDeps['banActions']>;
    rows?: Partial<Record<BanState, BanRow[]>>;
  } = {},
) {
  const banActions = { ...fakeBanActions(), ...options.actions };
  const isLeadership = vi.fn<(id: string) => Promise<boolean>>(async () => {
    if (options.leader instanceof Error) {
      throw options.leader;
    }
    return options.leader ?? true;
  });
  const bans = fakeBans(options.rows ?? { active: [banRow({ id: 3 })] });
  const { req } = await makeApp({
    now: () => PAGE_NOW.getTime(),
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({
          isLeadership,
          banActions,
          bans: async () => bans,
        }),
      }),
  });
  const cookie = await signIn(req);
  const token = await tokenOf(req, cookie);
  const get = (path: string) => req.get(path).set('Cookie', cookie);
  const post = (path: string, body: Record<string, string> = {}) =>
    req
      .post(path)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: token, ...body });
  const postRaw = (path: string, body: string) =>
    req
      .post(path)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send(`_csrf=${encodeURIComponent(token)}&${body}`);
  return { banActions, isLeadership, get, post, postRaw };
}

const location = (res: { headers: Record<string, unknown> }) =>
  String(res.headers.location);
const BACK = (code: string) =>
  `/dashboard/suspensions?state=banned&result=${code}`;
const ADD = { memberId: '424242', memberName: 'Ann', bannedOn: '', notes: '' };

describe('ban forms on the Banned tab', () => {
  it('a Moderator sees no ban forms; a Leader sees Add, Import and Lift', async () => {
    const moderator = await postSetup({ leader: false });
    const plain = await moderator.get(TAB);
    expect(plain.status).toBe(200);
    expect(plain.text).not.toContain('action="/dashboard/bans"');
    expect(plain.text).not.toContain('action="/dashboard/bans/import"');
    expect(plain.text).not.toContain('/lift"');
    expect(words(plain.text)).toContain(
      'Only the 1.5 Leadership Team can record, import, upload or lift a ban.',
    );

    const leader = await postSetup({ leader: true });
    const page = await leader.get(TAB);
    expect(page.text).toContain('action="/dashboard/bans"');
    expect(page.text).toContain('action="/dashboard/bans/import"');
    expect(page.text).toContain('action="/dashboard/bans/3/lift"');
    expect(page.text).toMatch(/name="memberId"[^>]*inputmode="numeric"/);
    expect(page.text).toContain('pattern="[0-9]{1,20}"');
    expect(page.text).toMatch(
      /type="date"[^>]*min="2013-03-01"[^>]*max="2026-10-05"/,
    );
    expect(page.text).toContain('name="csv"');
    expect(page.text).toContain('member_id,member_name,banned_on,notes');
    expect(page.text).toMatch(/<textarea[^>]*name="reason"[^>]*required/);
    expect(page.text).toContain('class="danger"');
    expect(words(page.text)).not.toContain('Only the 1.5 Leadership Team');
    expect(
      (page.text.match(/name="_csrf"/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
    // The lifted list has no Lift form.
    const lifted = await leader.get(`${TAB}&show=lifted`);
    expect(lifted.text).not.toContain('/lift"');
  });

  it('POST /bans records as the session user and redirects with recorded', async () => {
    const { post, banActions } = await postSetup();
    const res = await post('/dashboard/bans', {
      ...ADD,
      notes: 'n',
      actor: '999999999999999999',
    });
    expect(res.status).toBe(303);
    expect(location(res)).toBe(BACK('recorded'));
    expect(banActions.record).toHaveBeenCalledWith({
      actor: USER.id,
      memberId: '424242',
      memberName: 'Ann',
      bannedOn: '',
      notes: 'n',
      leadershipConfirmed: true,
    });
  });

  it('POST /bans by a Moderator is refused live even with a cached Leader page', async () => {
    const { get, post, isLeadership, banActions } = await postSetup();
    const page = await get(TAB);
    expect(page.text).toContain('action="/dashboard/bans"');
    expect(location(await post('/dashboard/bans', ADD))).toBe(BACK('recorded'));
    expect(banActions.record).toHaveBeenCalledTimes(1);
    // The role goes: the next POST asks Discord again, within seconds.
    isLeadership.mockResolvedValue(false);
    const res = await post('/dashboard/bans', ADD);
    expect(location(res)).toBe(BACK('not-leadership'));
    expect(banActions.record).toHaveBeenCalledTimes(1);
    for (const [path, body] of [
      ['/dashboard/bans/import', { csv: 'x' }],
      ['/dashboard/bans/3/lift', { reason: 'r' }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      expect(location(await post(path, body))).toBe(BACK('not-leadership'));
    }
    expect(banActions.import).not.toHaveBeenCalled();
    expect(banActions.lift).not.toHaveBeenCalled();
  });

  it('POST /bans when Discord times out answers leadership-unavailable', async () => {
    const { post, isLeadership, banActions } = await postSetup();
    let asked: () => void = () => undefined;
    const askedPromise = new Promise<void>((resolve) => {
      asked = resolve;
    });
    isLeadership.mockImplementation(() => {
      asked();
      return never();
    });
    fakeTimers();
    let settled = false;
    const pending = post('/dashboard/bans', ADD).then((res) => {
      settled = true;
      return res;
    });
    await askedPromise;
    await vi.advanceTimersByTimeAsync(LEADERSHIP_CHECK_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(location(res)).toBe(BACK('leadership-unavailable'));
    expect(banActions.record).not.toHaveBeenCalled();
  });

  it('a service that hangs answers error after 20 s', async () => {
    let started: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { post } = await postSetup({
      actions: {
        record: vi.fn(() => {
          started();
          return never<{ code: 'recorded' }>();
        }),
      },
    });
    fakeTimers();
    let settled = false;
    const pending = post('/dashboard/bans', ADD).then((res) => {
      settled = true;
      return res;
    });
    await startedPromise;
    await vi.advanceTimersByTimeAsync(BAN_REQUEST_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(location(await pending)).toBe(BACK('error'));
  });

  it('a service that throws answers error', async () => {
    const { post } = await postSetup({
      actions: { record: vi.fn(() => Promise.reject(new Error('db down'))) },
    });
    expect(location(await post('/dashboard/bans', ADD))).toBe(BACK('error'));
  });

  it('Review Focus 2: a spoofed member id reaches the service as typed and the notice is fixed text', async () => {
    const { post, get, banActions } = await postSetup({
      actions: {
        record: vi.fn(async () => ({ code: 'bad-member-id' as const })),
      },
    });
    const res = await post('/dashboard/bans', { ...ADD, memberId: '١٢٣<b>' });
    expect(banActions.record).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: '١٢٣<b>' }),
    );
    expect(location(res)).toBe(BACK('bad-member-id'));
    const page = await get(location(res));
    expect(page.text).toContain(BAN_RESULT_MESSAGES['bad-member-id']);
    expect(page.text).not.toContain('١٢٣');
  });

  it('?result=<script> and unknown codes render no notice', async () => {
    const { get } = await postSetup();
    const known = await get(`${TAB}&result=recorded`);
    expect(known.text).toContain(BAN_RESULT_MESSAGES.recorded);
    expect(known.text).toContain('class="note info"');
    const coral = await get(`${TAB}&result=already-banned`);
    expect(coral.text).toContain('class="note attn"');
    for (const junk of ['%3Cscript%3E', 'toString', 'constructor', 'nope']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await get(`${TAB}&result=${junk}`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('<script>');
      expect(res.text).not.toMatch(/class="note (info|attn)"/);
    }
  });

  it('an import refusal renders 422 with Row N lines and nothing from the CSV', async () => {
    const errors = Array.from({ length: 12 }, (_, i) => ({
      row: i + 2,
      code: 'member-id' as const,
    }));
    const { post, banActions } = await postSetup({
      actions: {
        import: vi.fn(async () => ({
          code: 'import-refused' as const,
          errors: [{ row: null, code: 'too-many-rows' as const }, ...errors],
        })),
      },
    });
    const res = await post('/dashboard/bans/import', {
      csv: 'member_id,member_name,banned_on,notes\nx,Evil<b>Name,,',
    });
    expect(res.status).toBe(422);
    expect(banActions.import).toHaveBeenCalledWith(
      expect.objectContaining({ actor: USER.id, leadershipConfirmed: true }),
    );
    const text = words(res.text);
    expect(text).toContain('Nothing was imported.');
    expect(text).toContain(
      'One import takes at most 200 bans. Split the file.',
    );
    expect(text).toContain(
      'Row 2: member_id must be the Meetup member number, digits only.',
    );
    expect(text).toContain('Row 10:');
    expect(text).not.toContain('Row 11:');
    expect(text).toContain('…and 3 more');
    expect(res.text).not.toContain('Evil');
    expect(res.text).not.toMatch(/<textarea[^>]*name="csv"[^>]*>[^<]+</);
    expect(res.text).toContain('<ul');
  });

  it('a successful import redirects imported; an empty csv is invalid', async () => {
    const { post, banActions } = await postSetup();
    expect(location(await post('/dashboard/bans/import', { csv: 'a,b' }))).toBe(
      BACK('imported'),
    );
    expect(location(await post('/dashboard/bans/import', { csv: '' }))).toBe(
      BACK('invalid'),
    );
    expect(location(await post('/dashboard/bans/import'))).toBe(
      BACK('invalid'),
    );
    expect(banActions.import).toHaveBeenCalledTimes(1);
  });

  it('POST /bans/abc/lift is a 404; a missing reason redirects reason-required', async () => {
    const repo = {
      record: vi.fn(),
      importMany: vi.fn(),
      lift: vi.fn(async () => undefined),
      setUploadedPhoto: vi.fn(),
    };
    const serviceDeps = {
      now: () => PAGE_NOW,
      repository: async () => repo,
      moderationLog: vi.fn(async () => true),
      isLeadership: vi.fn(async () => false),
    };
    const { post } = await postSetup({
      actions: { lift: (input) => liftBan(serviceDeps, input) },
    });
    for (const id of ['abc', '0', '01', '1234567890']) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await post(`/dashboard/bans/${id}/lift`, { reason: 'r' });
      expect(res.status).toBe(404);
    }
    expect(location(await post('/dashboard/bans/3/lift'))).toBe(
      BACK('reason-required'),
    );
    expect(
      location(await post('/dashboard/bans/3/lift', { reason: 'ok' })),
    ).toBe(BACK('not-active'));
    expect(repo.lift).toHaveBeenCalledWith(3, USER.id, 'ok');
    expect(serviceDeps.isLeadership).not.toHaveBeenCalled();
  });

  it('a repeated field is invalid', async () => {
    const { postRaw, banActions } = await postSetup();
    expect(
      location(await postRaw('/dashboard/bans', 'memberId=1&memberId=2')),
    ).toBe(BACK('invalid'));
    expect(
      location(await postRaw('/dashboard/bans/import', 'csv=a&csv=b')),
    ).toBe(BACK('invalid'));
    expect(
      location(await postRaw('/dashboard/bans/3/lift', 'reason=a&reason=b')),
    ).toBe(BACK('invalid'));
    expect(banActions.record).not.toHaveBeenCalled();
    expect(banActions.import).not.toHaveBeenCalled();
    expect(banActions.lift).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LogEntry } from '../../../src/lib/helpers/discordLogger.js';
import { registerAllProtectedRoutes } from '../../../src/web/routes/dashboardPages.js';
import { SessionStore } from '../../../src/web/session.js';
import {
  Client,
  ORIGIN,
  USER,
  closeServers,
  makeApp,
  signIn,
} from '../dashboardHarness.js';
import { FakeCache } from '../fakeCache.js';
import { fakeOrganizerDeps, fakePageDeps } from './pageFakes.js';

afterEach(closeServers);

const TARGET = { id: '999999999999999999', username: 'Target' };

async function setup() {
  let clock = Date.parse('2026-10-05T16:15:00Z');
  const cache = new FakeCache();
  const isLeadership = vi.fn<(id: string) => Promise<boolean>>();
  const audit = vi.fn<(entry: LogEntry) => Promise<unknown>>(async () => true);
  const store = new SessionStore(cache, () => clock);
  const revokeUser = vi.spyOn(SessionStore.prototype, 'revokeUser');
  const fetchIdentity = vi.fn().mockResolvedValue(USER);
  const { req } = await makeApp({
    cache: async () => cache,
    now: () => clock,
    oauth: {
      buildLoginUrl: (s: string) => `https://discord.com/x?state=${s}`,
      exchangeCode: vi.fn().mockResolvedValue('access'),
      fetchIdentity,
    },
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({
          sessionStore: () => Promise.resolve(store),
          isLeadership,
          audit,
        }),
      }),
  });
  const signInAs = async (who: { id: string; username: string }) => {
    fetchIdentity.mockResolvedValueOnce(who);
    return signIn(req);
  };
  return {
    req,
    cache,
    isLeadership,
    audit,
    revokeUser,
    signInAs,
    tick: () => {
      clock += 1;
    },
  };
}

async function tokenOf(req: Client, cookie: string): Promise<string> {
  const page = await req.get('/dashboard/sessions').set('Cookie', cookie);
  expect(page.status).toBe(200);
  return /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
}

async function revoke(
  req: Client,
  cookie: string,
  body: Record<string, string>,
) {
  return req
    .post('/dashboard/sessions/revoke')
    .set('Cookie', cookie)
    .set('Origin', ORIGIN)
    .type('form')
    .send({ _csrf: await tokenOf(req, cookie), ...body });
}

const works = async (req: Client, cookie: string) =>
  (await req.get('/dashboard').set('Cookie', cookie)).status;

describe('sessions page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('any staff member can sign themselves out everywhere', async () => {
    const { req, signInAs, tick, audit, isLeadership } = await setup();
    const first = await signInAs(USER);
    const second = await signInAs(USER);
    tick();
    const res = await revoke(req, first, { userId: USER.id });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/dashboard/login');
    expect(isLeadership).not.toHaveBeenCalled();
    expect(await works(req, first)).toBe(302);
    expect(await works(req, second)).toBe(302);
    await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(1));
    expect(audit.mock.calls[0][0].description).toBe(
      `<@${USER.id}> signed out of the staff dashboard everywhere.`,
    );
  });

  it("ending another user's sessions needs Leadership", async () => {
    const { req, signInAs, tick, isLeadership, audit } = await setup();
    const actor = await signInAs(USER);
    const target = await signInAs(TARGET);
    tick();
    isLeadership.mockResolvedValue(false);
    const res = await revoke(req, actor, { userId: TARGET.id });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(
      '/dashboard/sessions?done=not-leadership',
    );
    expect(isLeadership).toHaveBeenCalledWith(USER.id);
    expect(await works(req, target)).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("Leadership can end another user's sessions", async () => {
    const { req, signInAs, tick, isLeadership } = await setup();
    const actor = await signInAs(USER);
    const target = await signInAs(TARGET);
    tick();
    isLeadership.mockResolvedValue(true);
    const res = await revoke(req, actor, { userId: TARGET.id });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/dashboard/sessions?done=done');
    expect(await works(req, target)).toBe(302);
    expect(await works(req, actor)).toBe(200);
  });

  it('a Discord failure changes nothing', async () => {
    const { req, signInAs, tick, isLeadership, revokeUser, audit } =
      await setup();
    const actor = await signInAs(USER);
    const target = await signInAs(TARGET);
    tick();
    isLeadership.mockRejectedValue(new Error('discord down'));
    const res = await revoke(req, actor, { userId: TARGET.id });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/dashboard/sessions?done=unavailable');
    expect(revokeUser).not.toHaveBeenCalled();
    expect(await works(req, target)).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses a malformed id', async () => {
    const { req, signInAs, revokeUser, isLeadership } = await setup();
    const actor = await signInAs(USER);
    for (const bad of ['123', '1'.repeat(21), '123456789012345678 ', '']) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const res = await revoke(req, actor, { userId: bad });
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe('/dashboard/sessions?done=bad-id');
    }
    const missing = await revoke(req, actor, {});
    expect(missing.headers.location).toBe('/dashboard/sessions?done=bad-id');
    expect(revokeUser).not.toHaveBeenCalled();
    expect(isLeadership).not.toHaveBeenCalled();
  });

  it('requires CSRF', async () => {
    const { req, signInAs, revokeUser } = await setup();
    const actor = await signInAs(USER);
    const res = await req
      .post('/dashboard/sessions/revoke')
      .set('Cookie', actor)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ userId: USER.id });
    expect(res.status).toBe(403);
    expect(revokeUser).not.toHaveBeenCalled();
    expect(await works(req, actor)).toBe(200);
  });

  it('audits who ended whose sessions, with no secrets', async () => {
    const { req, signInAs, tick, isLeadership, audit, cache } = await setup();
    const actor = await signInAs(USER);
    await signInAs(TARGET);
    tick();
    isLeadership.mockResolvedValue(true);
    await revoke(req, actor, { userId: TARGET.id });
    await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(1));
    const entry = audit.mock.calls[0][0];
    expect(entry.title).toBe('Dashboard sessions ended');
    expect(entry.description).toBe(
      `<@${USER.id}> signed <@${TARGET.id}> out of the staff dashboard everywhere.`,
    );
    const text = JSON.stringify(entry);
    const secrets = [...cache.values.entries()].flatMap(([key, value]) => [
      key,
      value,
    ]);
    for (const secret of secrets) {
      if (!/^[0-9]+$/.test(secret)) {
        expect(text).not.toContain(secret);
      }
    }
    expect(text).not.toContain(actor.split('=')[1]);
  });

  it('an audit failure does not break the revocation', async () => {
    const { req, signInAs, tick, audit } = await setup();
    audit.mockRejectedValue(new Error('discord down'));
    const actor = await signInAs(USER);
    tick();
    const res = await revoke(req, actor, { userId: USER.id });
    expect(res.status).toBe(303);
    expect(await works(req, actor)).toBe(302);
  });

  it('shows each known notice and nothing for an unknown done code', async () => {
    const { req, signInAs } = await setup();
    const actor = await signInAs(USER);
    const page = (done: string) =>
      req
        .get(`/dashboard/sessions?done=${encodeURIComponent(done)}`)
        .set('Cookie', actor);
    expect((await page('done')).text).toContain(
      'That staff member was signed out everywhere.',
    );
    expect((await page('not-leadership')).text).toContain(
      'Only the 1.5 Leadership Team can sign out another staff member.',
    );
    const unknown = await page('<script>x</script>');
    expect(unknown.status).toBe(200);
    expect(unknown.text).not.toContain('class="note');
    expect(unknown.text).not.toContain('<script>x');
    const proto = await page('toString');
    expect(proto.text).not.toContain('class="note');
    // Self-revoke lands on the login page, so there is no 'self' notice.
    const self = await page('self');
    expect(self.text).not.toContain('class="note');
    expect(self.text).not.toContain('You were signed out everywhere');
  });

  it('the page has both forms with the CSRF token', async () => {
    const { req, signInAs } = await setup();
    const actor = await signInAs(USER);
    const res = await req.get('/dashboard/sessions').set('Cookie', actor);
    expect(res.status).toBe(200);
    expect(
      res.text.match(/action="\/dashboard\/sessions\/revoke"/g),
    ).toHaveLength(2);
    expect(res.text).toContain(`name="userId" value="${USER.id}"`);
    expect(res.text).toContain('Sign me out everywhere');
    expect(res.text).toContain('Sign them out everywhere');
  });
});

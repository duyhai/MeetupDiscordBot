import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthStateRecord } from '../../../src/lib/client/oauth/state.js';
import {
  createDashboardRouter,
  protectedRouteList,
} from '../../../src/web/dashboardRouter.js';
import {
  OrganizerLoginDeps,
  registerOrganizerLoginRoutes,
} from '../../../src/web/routes/organizerLogin.js';
import {
  Client,
  ORIGIN,
  USER,
  closeServers,
  makeApp,
  makeDeps,
  signIn,
} from '../dashboardHarness.js';

const fake = vi.hoisted(() => ({ logged: [] as string[] }));

vi.mock('tslog', () => {
  const renderOne = (arg: unknown) => {
    if (arg instanceof Error) {
      return `${arg.message} ${arg.stack ?? ''}`;
    }
    return typeof arg === 'string' ? arg : JSON.stringify(arg);
  };
  const render = (args: unknown[]) => args.map(renderOne).join(' ');
  class Logger {
    debug = (...args: unknown[]) => fake.logged.push(render(args));

    info = (...args: unknown[]) => fake.logged.push(render(args));

    warn = (...args: unknown[]) => fake.logged.push(render(args));

    error = (...args: unknown[]) => fake.logged.push(render(args));
  }
  return { Logger };
});

afterEach(closeServers);

const ORGANIZER_ID = '468174923';
const OTHER_ID = '999000111';
const TOKENS = {
  accessToken: 'ACCESS-SECRET-TOKEN',
  refreshToken: 'REFRESH-SECRET-TOKEN',
  expiresAt: Date.now() + 3600_000,
};
const MEETUP_AUTHORIZE = 'https://secure.meetup.com/oauth2/authorize';

const sha256 = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');
/** The session id inside a `dash_sid=<sid>.<mac>` cookie pair. */
const sidOf = (cookie: string) =>
  cookie.slice('dash_sid='.length, cookie.lastIndexOf('.'));

/** An in-memory stand-in for the OAuth state store. */
function fakeStates() {
  const records = new Map<string, OAuthStateRecord>();
  const claimed = new Set<string>();
  return {
    records,
    createState: vi.fn(async (discordUserId: string, sessionHash: string) => {
      const state = crypto.randomUUID();
      records.set(state, {
        discordUserId,
        purpose: 'organizer-renew',
        sessionHash,
      });
      return state;
    }),
    resolveState: vi.fn(async (state: string) => records.get(state)),
    claimState: vi.fn(async (state: string) => {
      if (claimed.has(state)) {
        return false;
      }
      claimed.add(state);
      return true;
    }),
  };
}

function organizerDeps(
  overrides: Partial<OrganizerLoginDeps> = {},
): OrganizerLoginDeps & { states: ReturnType<typeof fakeStates> } {
  const states = fakeStates();
  return {
    states,
    credentialStatus: vi
      .fn()
      .mockResolvedValue({ memberId: ORGANIZER_ID, failingSince: null }),
    expectedMemberId: vi.fn().mockResolvedValue(ORGANIZER_ID),
    createState: states.createState,
    resolveState: states.resolveState,
    claimState: states.claimState,
    buildAuthUrl: vi.fn(
      (state: string) => `${MEETUP_AUTHORIZE}?state=${state}&client_id=k`,
    ),
    exchangeCode: vi.fn().mockResolvedValue(TOKENS),
    fetchMeetupMemberId: vi.fn().mockResolvedValue(ORGANIZER_ID),
    saveRenewedCredential: vi.fn().mockResolvedValue(undefined),
    audit: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

async function setup(
  overrides: Partial<OrganizerLoginDeps> = {},
  dashboard: Parameters<typeof makeApp>[0] = {},
) {
  const org = organizerDeps(overrides);
  const app = await makeApp({
    ...dashboard,
    protectedRoutes: (r) => registerOrganizerLoginRoutes(r, org),
  });
  const cookie = await signIn(app.req);
  return { ...app, org, cookie };
}

const csrfOf = (page: string) => {
  const match = /name="_csrf" value="([^"]+)"/.exec(page);
  if (!match) {
    throw new Error('page has no CSRF field');
  }
  return match[1];
};

/** The continue link on the start page, attribute-unescaped. */
function continueHref(page: string): string {
  const match =
    /<a class="button" href="([^"]+)">Continue to Meetup sign-in<\/a>/.exec(
      page,
    );
  if (!match) {
    throw new Error('start page has no continue link');
  }
  return match[1].replace(/&amp;/g, '&');
}

async function startRenewal(req: Client, cookie: string): Promise<string> {
  const page = await req
    .get('/dashboard/organizer-login')
    .set('Cookie', cookie);
  const res = await req
    .post('/dashboard/organizer-login/start')
    .set('Cookie', cookie)
    .set('Origin', ORIGIN)
    .type('form')
    .send({ _csrf: csrfOf(page.text) });
  if (res.status !== 200) {
    throw new Error(`start answered ${res.status}`);
  }
  return new URL(continueHref(res.text)).searchParams.get('state');
}

const complete = (req: Client, cookie: string, query: Record<string, string>) =>
  req
    .get(
      `/dashboard/organizer-login/complete?${new URLSearchParams(query).toString()}`,
    )
    .set('Cookie', cookie);

const auditText = (org: OrganizerLoginDeps) =>
  JSON.stringify(vi.mocked(org.audit).mock.calls);
const auditTitles = (org: OrganizerLoginDeps) =>
  vi.mocked(org.audit).mock.calls.map(([entry]) => entry.title);

beforeEach(() => {
  fake.logged.length = 0;
});

describe('organizer login routes', () => {
  it('signed out → 302 / role gone → 403 on every organizer route', async () => {
    const org = organizerDeps();
    const listed = protectedRouteList(
      createDashboardRouter({
        ...makeDeps().deps,
        protectedRoutes: (r) => registerOrganizerLoginRoutes(r, org),
      }),
    );
    expect(listed).toEqual(
      expect.arrayContaining([
        { method: 'get', path: '/organizer-login' },
        { method: 'post', path: '/organizer-login/start' },
        { method: 'get', path: '/organizer-login/complete' },
      ]),
    );
    const routes = listed.filter((r) => r.path.startsWith('/organizer-login'));
    expect(routes).toHaveLength(3);

    let now = 0;
    const checkAccess = vi.fn().mockResolvedValue(true);
    const { req, cookie } = await setup({}, { checkAccess, now: () => now });
    const call = (method: string, path: string, withCookie: boolean) => {
      const r =
        method === 'post'
          ? req.post(`/dashboard${path}`).set('Origin', ORIGIN)
          : req.get(`/dashboard${path}`);
      return withCookie ? r.set('Cookie', cookie) : r;
    };

    for (const { method, path } of routes) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(method, path, false);
      if (method === 'get') {
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/dashboard/login');
      } else {
        expect(res.status).toBe(403);
      }
    }

    now = 10 * 60 * 1000;
    checkAccess.mockResolvedValue(false);
    const statuses: Record<string, number> = {};
    for (const { method, path } of routes) {
      // eslint-disable-next-line no-await-in-loop
      statuses[`${method} ${path}`] = (await call(method, path, true)).status;
    }
    // The first request ends the session (403); after that there is none, so
    // the POST is refused (403) and the GET goes to sign-in (302).
    expect(statuses).toEqual({
      'get /organizer-login': 403,
      'post /organizer-login/start': 403,
      'get /organizer-login/complete': 302,
    });
    expect((await call('get', routes[0].path, true)).status).toBe(302);
    expect(org.createState).not.toHaveBeenCalled();
  });

  it('role gone → 403 on each organizer route as the first request', async () => {
    for (const [method, path] of [
      ['get', '/organizer-login'],
      ['post', '/organizer-login/start'],
      ['get', '/organizer-login/complete?state=x&code=y'],
    ]) {
      let now = 0;
      const checkAccess = vi.fn().mockResolvedValue(true);
      // eslint-disable-next-line no-await-in-loop
      const { req, cookie, org } = await setup(
        {},
        { checkAccess, now: () => now },
      );
      now = 10 * 60 * 1000;
      checkAccess.mockResolvedValue(false);
      const r =
        method === 'post'
          ? req.post(`/dashboard${path}`).set('Origin', ORIGIN)
          : req.get(`/dashboard${path}`);
      // eslint-disable-next-line no-await-in-loop
      expect((await r.set('Cookie', cookie)).status).toBe(403);
      expect(org.createState).not.toHaveBeenCalled();
      expect(org.resolveState).not.toHaveBeenCalled();
    }
  });

  it('start requires CSRF', async () => {
    const { req, cookie, org } = await setup();
    const page = await req
      .get('/dashboard/organizer-login')
      .set('Cookie', cookie);
    const token = csrfOf(page.text);

    const missing = await req
      .post('/dashboard/organizer-login/start')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({});
    const wrong = await req
      .post('/dashboard/organizer-login/start')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: `${token}x` });
    const crossOrigin = await req
      .post('/dashboard/organizer-login/start')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .type('form')
      .send({ _csrf: token });

    expect([missing.status, wrong.status, crossOrigin.status]).toEqual([
      403, 403, 403,
    ]);
    expect(org.createState).not.toHaveBeenCalled();
  });

  it('start binds the state to this session and links to Meetup', async () => {
    const { req, cookie, org } = await setup();
    const page = await req
      .get('/dashboard/organizer-login')
      .set('Cookie', cookie);
    const res = await req
      .post('/dashboard/organizer-login/start')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: csrfOf(page.text) });

    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(org.createState).toHaveBeenCalledWith(
      USER.id,
      sha256(sidOf(cookie)),
    );
    const state = [...org.states.records.keys()][0];
    expect(continueHref(res.text)).toBe(org.buildAuthUrl(state));
    // The raw session id never leaves the dashboard.
    expect(JSON.stringify(org.states.records.get(state))).not.toContain(
      sidOf(cookie),
    );
  });

  it('complete refuses a state from another session', async () => {
    const { req, cookie, org } = await setup();
    const state = await startRenewal(req, cookie);

    // Same Discord user, different browser session.
    const otherSession = await signIn(req);
    const fromOtherSession = await complete(req, otherSession, {
      state,
      code: 'c',
    });
    expect(fromOtherSession.status).toBe(400);
    expect(fromOtherSession.text).toContain(
      'This renewal link expired or belongs to another session. Start again.',
    );

    // Bound to this session's hash, but issued to someone else.
    const foreign = crypto.randomUUID();
    org.states.records.set(foreign, {
      discordUserId: '222222222222222222',
      purpose: 'organizer-renew',
      sessionHash: sha256(sidOf(cookie)),
    });
    expect(
      (await complete(req, cookie, { state: foreign, code: 'c' })).status,
    ).toBe(400);

    expect(org.claimState).not.toHaveBeenCalled();
    expect(org.exchangeCode).not.toHaveBeenCalled();
    expect(org.saveRenewedCredential).not.toHaveBeenCalled();

    // The state is still good in the session that started it.
    expect((await complete(req, cookie, { state, code: 'c' })).status).toBe(
      200,
    );
  });

  it('complete refuses a member-link state', async () => {
    const { req, cookie, org } = await setup();
    const memberLink = crypto.randomUUID();
    org.states.records.set(memberLink, { discordUserId: USER.id });
    // Even one that somehow carried this session's hash.
    const hashed = crypto.randomUUID();
    org.states.records.set(hashed, {
      discordUserId: USER.id,
      sessionHash: sha256(sidOf(cookie)),
    });
    expect(
      (await complete(req, cookie, { state: hashed, code: 'c' })).status,
    ).toBe(400);
    const noState = await req
      .get('/dashboard/organizer-login/complete?code=c')
      .set('Cookie', cookie);

    const res = await complete(req, cookie, { state: memberLink, code: 'c' });

    expect(res.status).toBe(400);
    expect(noState.status).toBe(400);
    expect(org.claimState).not.toHaveBeenCalled();
    expect(org.exchangeCode).not.toHaveBeenCalled();
  });

  it('complete refuses a replayed state', async () => {
    const { req, cookie, org } = await setup();
    const state = await startRenewal(req, cookie);

    expect((await complete(req, cookie, { state, code: 'c1' })).status).toBe(
      200,
    );
    const replay = await complete(req, cookie, { state, code: 'c2' });

    expect(replay.status).toBe(400);
    expect(replay.text).toContain('belongs to another session');
    expect(org.exchangeCode).toHaveBeenCalledTimes(1);
    expect(org.saveRenewedCredential).toHaveBeenCalledTimes(1);
  });

  it('stores the right account through the locked write', async () => {
    const { req, cookie, org } = await setup();
    const state = await startRenewal(req, cookie);

    const res = await complete(req, cookie, { state, code: 'the-code' });

    expect(res.status).toBe(200);
    expect(res.text).toContain(
      'Meetup organizer login renewed. Identity monitoring resumes with the next sweep.',
    );
    expect(org.exchangeCode).toHaveBeenCalledWith('the-code');
    expect(org.fetchMeetupMemberId).toHaveBeenCalledWith(TOKENS.accessToken);
    expect(org.saveRenewedCredential).toHaveBeenCalledWith(
      TOKENS,
      ORGANIZER_ID,
    );
    expect(auditTitles(org)).toContain('Organizer login renewed');
    expect(res.text).not.toContain(ORGANIZER_ID);
  });

  it('refuses the wrong account and stores nothing', async () => {
    const { req, cookie, org } = await setup({
      fetchMeetupMemberId: vi.fn().mockResolvedValue(OTHER_ID),
    });
    const state = await startRenewal(req, cookie);

    const res = await complete(req, cookie, { state, code: 'c' });

    expect(res.status).toBe(403);
    expect(res.text).toContain(
      'This Meetup account is not the shared organizer account. Nothing was saved.',
    );
    expect(org.saveRenewedCredential).not.toHaveBeenCalled();
    expect(auditTitles(org)).toContain('Organizer login renewal refused');
    expect(auditText(org)).toContain('does not match');
    for (const shown of [res.text, auditText(org)]) {
      expect(shown).not.toContain(OTHER_ID);
      expect(shown).not.toContain(ORGANIZER_ID);
    }
  });

  it('refuses a member id that is not all digits', async () => {
    const { req, cookie, org } = await setup({
      fetchMeetupMemberId: vi.fn().mockResolvedValue(`${ORGANIZER_ID} `),
    });
    const state = await startRenewal(req, cookie);

    expect((await complete(req, cookie, { state, code: 'c' })).status).toBe(
      502,
    );
    expect(org.saveRenewedCredential).not.toHaveBeenCalled();
  });

  it('bootstrap: refuses when neither is set', async () => {
    const { req, cookie, org } = await setup({
      expectedMemberId: vi.fn().mockResolvedValue(undefined),
    });
    const state = await startRenewal(req, cookie);

    const res = await complete(req, cookie, { state, code: 'c' });

    expect(res.status).toBe(409);
    expect(res.text).toContain(
      'No organizer account is on record. Set MEETUP_ORGANIZER_MEMBER_ID.',
    );
    expect(org.saveRenewedCredential).not.toHaveBeenCalled();
    expect(auditTitles(org)).toContain('Organizer login renewal refused');
    expect(auditText(org)).toContain('not configured');
  });

  it('cancel is refused and audited', async () => {
    const { req, cookie, org } = await setup();
    const state = await startRenewal(req, cookie);

    const res = await complete(req, cookie, { state, error: 'access_denied' });

    expect(res.status).toBe(400);
    expect(res.text).toContain('Meetup sign-in was cancelled.');
    expect(org.exchangeCode).not.toHaveBeenCalled();
    expect(auditTitles(org)).toContain('Organizer login renewal cancelled');
    // A cancelled state is spent too.
    expect((await complete(req, cookie, { state, code: 'c' })).status).toBe(
      400,
    );
  });

  it('an error with a code is still a cancel', async () => {
    const { req, cookie, org } = await setup();
    const state = await startRenewal(req, cookie);

    const res = await complete(req, cookie, {
      state,
      code: 'c',
      error: 'access_denied',
    });

    expect(res.status).toBe(400);
    expect(org.exchangeCode).not.toHaveBeenCalled();
  });

  it('exchange failure is a generic 502 with no body', async () => {
    const { req, cookie, org } = await setup({
      exchangeCode: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Meetup token exchange failed: [400] {"error":"invalid_grant","echo":"RAW-BODY-SECRET"}',
          ),
        ),
    });
    const state = await startRenewal(req, cookie);

    const res = await complete(req, cookie, { state, code: 'c' });

    expect(res.status).toBe(502);
    const logs = fake.logged.join('\n');
    for (const shown of [res.text, auditText(org), logs]) {
      expect(shown).not.toContain('RAW-BODY-SECRET');
      expect(shown).not.toContain('invalid_grant');
    }
    expect(logs).toMatch(/Error.*400/);
    expect(org.saveRenewedCredential).not.toHaveBeenCalled();
  });

  it('a member id lookup failure is a generic 502 that logs the error name only', async () => {
    class ClientError extends Error {
      name = 'ClientError';
    }
    const { req, cookie, org } = await setup({
      fetchMeetupMemberId: vi
        .fn()
        .mockRejectedValue(new ClientError('RAW-GRAPHQL-BODY')),
    });
    const state = await startRenewal(req, cookie);

    const res = await complete(req, cookie, { state, code: 'c' });

    expect(res.status).toBe(502);
    expect(fake.logged.join('\n')).toContain('ClientError');
    expect(fake.logged.join('\n') + res.text).not.toContain('RAW-GRAPHQL-BODY');
    expect(org.saveRenewedCredential).not.toHaveBeenCalled();
  });

  it('a save failure is a generic 503 and is audited', async () => {
    const { req, cookie, org } = await setup({
      saveRenewedCredential: vi
        .fn()
        .mockRejectedValue(new Error(`write failed ${TOKENS.accessToken}`)),
    });
    const state = await startRenewal(req, cookie);

    const res = await complete(req, cookie, { state, code: 'c' });

    expect(res.status).toBe(503);
    expect(auditTitles(org)).toContain('Organizer login renewal failed');
    expect(auditTitles(org)).not.toContain('Organizer login renewed');
    expect(fake.logged.join('\n') + res.text).not.toContain(TOKENS.accessToken);
  });

  it('an account-guard rejection is logged by name, with the same generic page', async () => {
    class OrganizerAccountChangedError extends Error {
      name = 'OrganizerAccountChangedError';
    }
    const { req, cookie, org } = await setup({
      saveRenewedCredential: vi
        .fn()
        .mockRejectedValue(new OrganizerAccountChangedError('changed')),
    });
    const state = await startRenewal(req, cookie);

    const res = await complete(req, cookie, { state, code: 'c' });

    expect(res.status).toBe(503);
    expect(res.text).toContain(
      'The renewed login could not be saved. Please start again in a minute.',
    );
    expect(fake.logged.join('\n')).toContain('OrganizerAccountChangedError');
    expect(auditTitles(org)).toContain('Organizer login renewal failed');
  });

  it('logs each attempt to the moderation channel with <@id> and no token', async () => {
    const { req, cookie, org } = await setup();
    const state = await startRenewal(req, cookie);
    await complete(req, cookie, { state, code: 'SECRET-CODE' });

    expect(auditTitles(org)).toEqual([
      'Organizer login renewal started',
      'Organizer login renewed',
    ]);
    for (const [entry] of vi.mocked(org.audit).mock.calls) {
      expect(entry.description).toContain(`<@${USER.id}>`);
    }
    const text = auditText(org);
    for (const secret of [
      TOKENS.accessToken,
      TOKENS.refreshToken,
      'SECRET-CODE',
      state,
      ORGANIZER_ID,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('an audit failure never breaks the renewal', async () => {
    const { req, cookie } = await setup({
      audit: vi.fn().mockRejectedValue(new Error('discord down')),
    });
    const state = await startRenewal(req, cookie);
    expect((await complete(req, cookie, { state, code: 'c' })).status).toBe(
      200,
    );
  });

  it('status page escapes and shows failing-since', async () => {
    const { req, cookie } = await setup(
      {
        credentialStatus: vi.fn().mockResolvedValue({
          memberId: ORGANIZER_ID,
          // 2026-10-14 17:05 UTC = 10:05 AM Pacific (PDT).
          failingSince: new Date('2026-10-14T17:05:00Z'),
        }),
      },
      {
        oauth: {
          buildLoginUrl: (state: string) =>
            `https://discord.com/oauth2/authorize?state=${state}`,
          exchangeCode: vi.fn().mockResolvedValue('access'),
          fetchIdentity: vi
            .fn()
            .mockResolvedValue({ id: USER.id, username: '<img src=x>' }),
        },
      },
    );

    const res = await req
      .get('/dashboard/organizer-login')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain('&lt;img src=x&gt;');
    expect(res.text).not.toContain('<img src=x>');
    expect(res.text).toContain(
      'Failing since Oct 14, 2026 10:05 AM Pacific time',
    );
    expect(res.text).toContain('Renew organizer login');
    expect(res.text).toContain('private window');
    expect(res.text).toContain('/meetup_get_token sweep_credential:True');
    expect(res.text).not.toContain(ORGANIZER_ID);
  });

  it('start renders a continue link to Meetup sign-in', async () => {
    const { req, cookie, org } = await setup();
    const page = await req
      .get('/dashboard/organizer-login')
      .set('Cookie', cookie);
    const res = await req
      .post('/dashboard/organizer-login/start')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: csrfOf(page.text) });

    expect(res.status).toBe(200);
    const href = continueHref(res.text);
    expect(href.startsWith(`${MEETUP_AUTHORIZE}?`)).toBe(true);
    expect(res.text).toContain('shared organizer account');
    expect(res.text).toContain('href="/dashboard/organizer-login"');
    expect(auditTitles(org)).toEqual(['Organizer login renewal started']);
    // The page only links: nothing redirects the POST off-site.
    expect(String(res.headers['content-security-policy'])).toContain(
      "form-action 'self';",
    );
  });

  it('start refuses to link anywhere but the Meetup authorize endpoint', async () => {
    const { req, cookie, org } = await setup({
      buildAuthUrl: vi.fn(() => 'https://evil.example/oauth2/authorize?x=1'),
    });
    const page = await req
      .get('/dashboard/organizer-login')
      .set('Cookie', cookie);
    const res = await req
      .post('/dashboard/organizer-login/start')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: csrfOf(page.text) });

    expect(res.status).toBe(500);
    expect(res.text).not.toContain('evil.example');
    expect(auditTitles(org)).not.toContain('Organizer login renewal started');
  });

  it("the status page keeps form-action 'self'", async () => {
    const { req, cookie } = await setup();
    const page = await req
      .get('/dashboard/organizer-login')
      .set('Cookie', cookie);

    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("form-action 'self';");
    expect(csp).not.toContain('meetup.com');
  });

  it('status page shows a healthy credential', async () => {
    const { req, cookie } = await setup();
    const res = await req
      .get('/dashboard/organizer-login')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Healthy');
    expect(res.text).not.toContain('Failing since');
  });

  it('without a credential store, renewal is unavailable and start answers 503', async () => {
    const { req, cookie, org } = await setup({
      credentialStatus: vi.fn().mockResolvedValue(undefined),
    });
    const page = await req
      .get('/dashboard/organizer-login')
      .set('Cookie', cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Renewal is unavailable');
    expect(page.text).not.toContain(
      'action="/dashboard/organizer-login/start"',
    );

    const home = await req.get('/dashboard').set('Cookie', cookie);
    const start = await req
      .post('/dashboard/organizer-login/start')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: csrfOf(home.text) });
    expect(start.status).toBe(503);
    expect(org.createState).not.toHaveBeenCalled();
  });

  it('a credential store outage is a 503 on the status page and on start', async () => {
    const { req, cookie, org } = await setup({
      credentialStatus: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    const page = await req
      .get('/dashboard/organizer-login')
      .set('Cookie', cookie);
    expect(page.status).toBe(503);

    const home = await req.get('/dashboard').set('Cookie', cookie);
    const start = await req
      .post('/dashboard/organizer-login/start')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: csrfOf(home.text) });
    expect(start.status).toBe(503);
    expect(org.createState).not.toHaveBeenCalled();
  });
});

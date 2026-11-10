import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GUEST_HOST_BLACKLIST } from '../../../src/constants.js';
import { DuplicateMeetupAccountError } from '../../../src/lib/helpers/memberLink.js';
import { NonMemberError } from '../../../src/lib/helpers/onboardUser.js';
import { HostResolution } from '../../../src/lib/hosts/eligibility.js';
import { WebLinkStore } from '../../../src/lib/hosts/webLink.js';
import {
  MeetupIdConflictError,
  MemberRecord,
} from '../../../src/lib/repositories/types.js';
import { HostRouterDeps } from '../../../src/web/host/hostRouter.js';
import { registerHostPages } from '../../../src/web/host/hostPages.js';
import { ROLE_RECHECK_MS, SESSION_MAX_SEC } from '../../../src/web/session.js';
import {
  LoopbackClient,
  LoopbackResponse,
} from '../../setup/loopbackServer.js';
import {
  DISCORD_USER,
  MEETUP_SELF,
  ORIGIN,
  closeServers,
  locationOf,
  makeHostApp,
  setCookie,
  signInWithDiscord,
  signInWithMeetup,
} from './hostHarness.js';

afterEach(closeServers);

const UNLINKED: HostResolution = {
  kind: 'host',
  meetupMemberId: MEETUP_SELF.id,
  discordUserId: null,
  tier: 'regular',
  hostedCount: 3,
};
const LINKED: HostResolution = {
  ...UNLINKED,
  discordUserId: DISCORD_USER.id,
  tier: 'promoted',
};
const OTHER_DISCORD = '223456789012345678';

const member = (over: Partial<MemberRecord>): MemberRecord => ({
  discordUserId: DISCORD_USER.id,
  meetupId: MEETUP_SELF.id,
  meetupName: MEETUP_SELF.name,
  meetupMemberUrl: null,
  onboardMethod: 'self_onboard',
  onboardedBy: null,
  firstOnboardedAt: new Date(0),
  lastSyncedAt: new Date(0),
  ...over,
});

function memberStore(rows: MemberRecord[] = []) {
  return {
    rows,
    findByMeetupId: vi.fn(async (id: string) =>
      rows.find((r) => r.meetupId === id),
    ),
    findByDiscordId: vi.fn(async (id: string) =>
      rows.find((r) => r.discordUserId === id),
    ),
    linkUnlessLinkedElsewhere: vi.fn(
      async (m: Omit<MemberRecord, 'firstOnboardedAt' | 'lastSyncedAt'>) => {
        const saved = member(m);
        rows.push(saved);
        return saved;
      },
    ),
  } satisfies WebLinkStore & { rows: MemberRecord[] };
}

async function setup(
  options: {
    rows?: MemberRecord[];
    members?: false;
    overrides?: Partial<HostRouterDeps>;
  } = {},
) {
  const store = memberStore(options.rows);
  // Unlinked at sign-in; linked once the row exists.
  const resolve = vi.fn(async () => {
    const linked = store.rows.some(
      (r) =>
        r.meetupId === MEETUP_SELF.id && r.discordUserId === DISCORD_USER.id,
    );
    return linked ? LINKED : UNLINKED;
  });
  const alert = vi.fn().mockResolvedValue(true);
  const app = await makeHostApp({
    resolve,
    alert,
    ...(options.members === false ? {} : { members: async () => store }),
    pages: (router) =>
      registerHostPages(router, {
        events: {
          fetchGroupEvents: async () => [],
          now: () => new Date('2026-11-03T18:00:00Z'),
        },
      }),
    ...options.overrides,
  });
  const sid = await signInWithMeetup(app.req);
  const session = () =>
    JSON.parse(
      [...app.cache.values.entries()].find(([k]) =>
        k.startsWith('host-session-'),
      )?.[1] ?? '{}',
    ) as { csrfToken: string; discordUserId: string | null; tier: string };
  return { ...app, store, resolve, alert, sid, session };
}

/**
 * The Discord authorize URL the start page links to. The start answers with
 * a page that LINKS to Discord, never a redirect: browsers apply the host
 * pages' `form-action 'self'` to every redirect after a form POST.
 */
function continueHref(start: LoopbackResponse): URL {
  expect(start.status).toBe(200);
  expect(start.headers.location).toBeUndefined();
  const href = /<a class="button" href="([^"]+)">Continue to Discord<\/a>/.exec(
    start.text,
  )?.[1];
  if (!href) {
    throw new Error(`no Continue to Discord link: ${start.text.slice(0, 400)}`);
  }
  const url = new URL(href.replace(/&amp;/g, '&'));
  expect(url.origin + url.pathname).toBe(
    'https://discord.com/oauth2/authorize',
  );
  return url;
}

/** POST the Link button, then come back from Discord with these params. */
async function link(
  req: LoopbackClient,
  sid: string,
  csrf: string,
  callback: (state: string) => string = (state) => `state=${state}&code=c`,
  beforeCallback: () => Promise<void> = async () => undefined,
) {
  const start = await req
    .post('/host/link/discord')
    .set('Cookie', sid)
    .set('Origin', ORIGIN)
    .type('form')
    .send({ _csrf: csrf });
  const target = continueHref(start);
  const state = target.searchParams.get('state') ?? '';
  const oauth = setCookie(start, 'host_oauth_discord') ?? '';
  await beforeCallback();
  const back = await req
    .get(`/host/auth/discord/callback?${callback(state)}`)
    .set('Cookie', `${sid}; ${oauth}`);
  return { state, back };
}

/** Edits the one stored host session in place (a parallel request's write). */
function patchStoredSession(
  cache: { values: Map<string, string> },
  patch: Record<string, unknown>,
) {
  const key = [...cache.values.keys()].find((k) =>
    k.startsWith('host-session-'),
  );
  if (!key) {
    throw new Error('no stored host session');
  }
  cache.values.set(
    key,
    JSON.stringify({
      ...(JSON.parse(cache.values.get(key) ?? '{}') as object),
      ...patch,
    }),
  );
}

/** The CSRF token a signed-in page carries, for a session setup() did not make. */
const csrfOnPage = (text: string) =>
  /name="_csrf" value="([^"]+)"/.exec(text)?.[1] ?? '';

describe('Verify on Discord', () => {
  it('the start needs the CSRF token and sends a link. state to Discord', async () => {
    const { req, sid, session } = await setup();
    const refused = await req
      .post('/host/link/discord')
      .set('Cookie', sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: 'wrong' });
    expect(refused.status).toBe(403);
    const start = await req
      .post('/host/link/discord')
      .set('Cookie', sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: session().csrfToken });
    // A 200 page in the host layout that links to Discord (see continueHref).
    const state = continueHref(start).searchParams.get('state') ?? '';
    expect(start.text).toContain('Signed in as');
    expect(start.text).toContain('Discord will ask you to sign in');
    expect(setCookie(start, 'host_oauth_discord')).toBeTruthy();
    // A random part, then a tag of the session that started it.
    expect(state).toMatch(/^link\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{22}$/);
  });

  it('links, logs it, updates the session at once and says so at home', async () => {
    const { req, sid, session, store, deps, resolve } = await setup();
    expect(session().discordUserId).toBeNull();
    const { back } = await link(req, sid, session().csrfToken);
    expect(locationOf(back).pathname + locationOf(back).search).toBe(
      '/host?link=linked',
    );
    expect(store.linkUnlessLinkedElsewhere).toHaveBeenCalledWith(
      expect.objectContaining({
        discordUserId: DISCORD_USER.id,
        meetupId: MEETUP_SELF.id,
        meetupName: MEETUP_SELF.name,
        onboardMethod: 'web_link',
      }),
    );
    expect(JSON.stringify(vi.mocked(deps.audit).mock.calls)).toContain(
      'Meetup account linked (host dashboard)',
    );
    // The session has the link and the re-checked tier, with no sign-out.
    expect(session()).toMatchObject({
      discordUserId: DISCORD_USER.id,
      tier: 'promoted',
    });
    expect(resolve).toHaveBeenLastCalledWith({
      meetupMemberId: MEETUP_SELF.id,
    });
    const home = await req.get('/host?link=linked').set('Cookie', sid);
    expect(home.text).toContain(
      'Your Meetup and Discord accounts are now linked.',
    );
    expect(home.text).not.toContain('Verify on Discord');
  });

  it('a cancelled or failed Discord sign-in changes nothing', async () => {
    const { req, sid, session, store, deps } = await setup();
    const cancelled = await link(
      req,
      sid,
      session().csrfToken,
      (state) => `state=${state}&error=access_denied`,
    );
    expect(cancelled.back.headers.location).toBe('/host?link=cancelled');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a vi.fn
    vi.mocked(deps.discord.exchangeCode).mockRejectedValueOnce(
      new Error('discord down'),
    );
    const failed = await link(req, sid, session().csrfToken);
    expect(failed.back.headers.location).toBe('/host?link=error');
    expect(store.linkUnlessLinkedElsewhere).not.toHaveBeenCalled();
    expect(session().discordUserId).toBeNull();
  });

  it('refuses a Meetup account linked to someone else, and alerts', async () => {
    const { req, sid, session, store, alert } = await setup({
      rows: [member({ discordUserId: OTHER_DISCORD })],
      overrides: {
        // The stale row is not this host's link, so sign-in sees none.
        resolve: vi.fn().mockResolvedValue(UNLINKED),
      },
    });
    const { back } = await link(req, sid, session().csrfToken);
    expect(back.headers.location).toBe('/host?link=meetup-taken');
    expect(store.linkUnlessLinkedElsewhere).not.toHaveBeenCalled();
    expect(JSON.stringify(alert.mock.calls)).toContain(
      'Duplicate Meetup link blocked (host dashboard)',
    );
  });

  it('refuses a Discord account linked to another Meetup account, and alerts', async () => {
    const { req, sid, session, store, alert } = await setup({
      rows: [member({ meetupId: '9999' })],
    });
    const { back } = await link(req, sid, session().csrfToken);
    expect(back.headers.location).toBe('/host?link=discord-taken');
    expect(store.linkUnlessLinkedElsewhere).not.toHaveBeenCalled();
    expect(JSON.stringify(alert.mock.calls)).toContain(
      'Duplicate Discord link blocked (host dashboard)',
    );
    expect(session().discordUserId).toBeNull();
  });

  it('a race lost to the unique key, or a store outage, links nothing', async () => {
    const { req, sid, session, store } = await setup();
    store.linkUnlessLinkedElsewhere.mockRejectedValueOnce(
      new MeetupIdConflictError('taken'),
    );
    expect(
      (await link(req, sid, session().csrfToken)).back.headers.location,
    ).toBe('/host?link=meetup-taken');
    store.findByMeetupId.mockRejectedValueOnce(new Error('pg down'));
    expect(
      (await link(req, sid, session().csrfToken)).back.headers.location,
    ).toBe('/host?link=error');
    expect(session().discordUserId).toBeNull();
  });

  it('a link callback without a host session links nothing', async () => {
    const { req, sid, session, store } = await setup();
    const start = await req
      .post('/host/link/discord')
      .set('Cookie', sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: session().csrfToken });
    const state = continueHref(start).searchParams.get('state') ?? '';
    const oauth = setCookie(start, 'host_oauth_discord') ?? '';
    const back = await req
      .get(`/host/auth/discord/callback?state=${state}&code=c`)
      .set('Cookie', oauth);
    expect(back.headers.location).toBe('/host/login');
    expect(store.linkUnlessLinkedElsewhere).not.toHaveBeenCalled();
  });

  it('a plain Discord sign-in never links, and linking is off without a store', async () => {
    const { req, store } = await setup();
    await signInWithDiscord(req);
    expect(store.linkUnlessLinkedElsewhere).not.toHaveBeenCalled();
    const off = await setup({ members: false });
    const res = await off.req
      .post('/host/link/discord')
      .set('Cookie', off.sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: off.session().csrfToken });
    expect(res.status).toBe(404);
  });

  it('a host refused before the write links nothing and loses every session', async () => {
    const { req, sid, session, store, resolve } = await setup();
    const csrf = session().csrfToken;
    resolve.mockResolvedValue({ kind: 'refused', reason: 'blacklisted' });
    const { back } = await link(req, sid, csrf);
    expect(back.status).toBe(403);
    expect(store.linkUnlessLinkedElsewhere).not.toHaveBeenCalled();
    expect((await req.get('/host').set('Cookie', sid)).status).toBe(302);
  });

  it('a Discord account that makes the host refused ends the session after the write', async () => {
    const { req, sid, session, store, resolve, deps } = await setup();
    const csrf = session().csrfToken;
    resolve
      .mockResolvedValueOnce(UNLINKED)
      .mockResolvedValueOnce({ kind: 'refused', reason: 'blacklisted' });
    const { back } = await link(req, sid, csrf);
    expect(back.status).toBe(403);
    expect(store.linkUnlessLinkedElsewhere).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(deps.audit).mock.calls)).toContain(
      'Host dashboard session ended',
    );
    expect((await req.get('/host').set('Cookie', sid)).status).toBe(302);
  });

  it('an outage before the write changes nothing; after it, the session is left for the gate', async () => {
    const { req, sid, session, store, resolve } = await setup();
    const csrf = session().csrfToken;
    resolve.mockRejectedValueOnce(new Error('discord down'));
    expect((await link(req, sid, csrf)).back.headers.location).toBe(
      '/host?link=error',
    );
    expect(store.linkUnlessLinkedElsewhere).not.toHaveBeenCalled();
    resolve
      .mockResolvedValueOnce(UNLINKED)
      .mockRejectedValueOnce(new Error('discord down'));
    const before = session();
    expect((await link(req, sid, csrf)).back.headers.location).toBe(
      '/host?link=linked',
    );
    expect(store.linkUnlessLinkedElsewhere).toHaveBeenCalledOnce();
    // Untouched: the gate's next re-check picks the link up by Meetup id.
    expect(session()).toEqual(before);
  });

  it('a link finishing in a different session links nothing', async () => {
    const { req, sid, session, store } = await setup();
    const start = await req
      .post('/host/link/discord')
      .set('Cookie', sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: session().csrfToken });
    const state = continueHref(start).searchParams.get('state') ?? '';
    const oauth = setCookie(start, 'host_oauth_discord') ?? '';
    // Someone else signs in with Meetup on this browser meanwhile.
    const other = await signInWithMeetup(req);
    const back = await req
      .get(`/host/auth/discord/callback?state=${state}&code=c`)
      .set('Cookie', `${other}; ${oauth}`);
    expect(back.headers.location).toBe('/host?link=error');
    expect(store.linkUnlessLinkedElsewhere).not.toHaveBeenCalled();
  });

  it('a host already linked is not linked again, and duplicate alerts are capped', async () => {
    const { req, sid, session, alert } = await setup({
      rows: [member({ meetupId: '9999' })],
    });
    const csrf = session().csrfToken;
    await link(req, sid, csrf);
    await link(req, sid, csrf);
    expect(
      alert.mock.calls.filter(([e]) =>
        JSON.stringify(e).includes('Duplicate Discord link blocked'),
      ),
    ).toHaveLength(1);
    // A session that already has a link: the button's POST says so.
    const linked = await setup({
      overrides: { resolve: vi.fn().mockResolvedValue(LINKED) },
    });
    expect(linked.session().discordUserId).toBe(DISCORD_USER.id);
    const res = await linked.req
      .post('/host/link/discord')
      .set('Cookie', linked.sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: linked.session().csrfToken });
    expect(res.headers.location).toBe('/host?link=already');
  });

  it('a Discord sign-in whose link is gone gets no Link button, and its POST is refused', async () => {
    // Signed in with Discord, then unlinked (/unlink in the server): the
    // session's username is a Discord name, so it must never become a
    // meetup_name.
    const { req, store } = await setup({
      overrides: { resolve: vi.fn().mockResolvedValue(UNLINKED) },
    });
    const viaDiscord = await signInWithDiscord(req);
    const home = await req.get('/host').set('Cookie', viaDiscord);
    expect(home.status).toBe(200);
    expect(home.text).not.toContain('Verify on Discord');
    const start = await req
      .post('/host/link/discord')
      .set('Cookie', viaDiscord)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: csrfOnPage(home.text) });
    expect(start.status).toBe(403);
    expect(setCookie(start, 'host_oauth_discord')).toBeUndefined();
    expect(store.linkUnlessLinkedElsewhere).not.toHaveBeenCalled();
  });

  it('a blacklisted Discord account is refused before the write, like any refusal', async () => {
    const { req, sid, session, store, resolve, deps } = await setup();
    const csrf = session().csrfToken;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a vi.fn
    vi.mocked(deps.discord.fetchIdentity).mockResolvedValueOnce({
      id: GUEST_HOST_BLACKLIST[0],
      username: 'Blocked',
    });
    const resolvesBefore = resolve.mock.calls.length;
    const { back } = await link(req, sid, csrf);
    expect(back.status).toBe(403);
    // Refused before the eligibility check and before the write: resolve()
    // cannot see a Discord id that is not linked yet.
    expect(resolve.mock.calls.length).toBe(resolvesBefore);
    expect(store.linkUnlessLinkedElsewhere).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(deps.audit).mock.calls)).toContain(
      'Host dashboard session ended',
    );
    expect(setCookie(back, 'host_sid')).toBe('host_sid=');
    expect((await req.get('/host').set('Cookie', sid)).status).toBe(302);
  });

  it('a session store outage at the callback links nothing', async () => {
    const { req, sid, session, store, cache } = await setup();
    const { back } = await link(
      req,
      sid,
      session().csrfToken,
      undefined,
      async () => {
        vi.spyOn(cache, 'get').mockRejectedValueOnce(new Error('redis down'));
      },
    );
    expect(back.headers.location).toBe('/host?link=error');
    expect(store.linkUnlessLinkedElsewhere).not.toHaveBeenCalled();
  });

  it('a session at the end of its lifetime keeps the link but is signed out', async () => {
    let clock = Date.now();
    const { req, sid, session, store, cache, resolve } = await setup({
      overrides: { now: () => clock },
    });
    const csrf = session().csrfToken;
    // One second before the 30-day cap at the callback's session read...
    patchStoredSession(cache, {
      createdAt: clock - SESSION_MAX_SEC * 1000 + 1000,
    });
    // ...and past it by the time the session is written back.
    resolve.mockImplementation(async () => {
      clock += 2000;
      return UNLINKED;
    });
    const { back } = await link(req, sid, csrf);
    expect(store.linkUnlessLinkedElsewhere).toHaveBeenCalledOnce();
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe('/host/login');
    expect(setCookie(back, 'host_sid')).toBe('host_sid=');
  });

  it('a callback for a session linked meanwhile links nothing more', async () => {
    const { req, sid, session, store, cache } = await setup();
    const { back } = await link(
      req,
      sid,
      session().csrfToken,
      undefined,
      // A parallel link finished first, or the gate's re-check saw one.
      async () => {
        patchStoredSession(cache, { discordUserId: DISCORD_USER.id });
      },
    );
    expect(back.headers.location).toBe('/host?link=already');
    expect(store.linkUnlessLinkedElsewhere).not.toHaveBeenCalled();
  });

  it('a callback for a session that is no longer a Meetup sign-in links nothing', async () => {
    const { req, sid, session, store, cache } = await setup();
    const { back } = await link(
      req,
      sid,
      session().csrfToken,
      undefined,
      // However a link got started, a Discord sign-in never writes one: its
      // name is a Discord name, not a Meetup one.
      async () => {
        patchStoredSession(cache, { via: 'discord' });
      },
    );
    expect(back.status).toBe(403);
    expect(store.linkUnlessLinkedElsewhere).not.toHaveBeenCalled();
  });

  it('a link already in the store is reported as such and taken into the session', async () => {
    // Linked by Verify after this Meetup sign-in saw no link.
    const { req, sid, session, store } = await setup({
      rows: [member({})],
      overrides: {
        resolve: vi
          .fn()
          .mockResolvedValueOnce(UNLINKED)
          .mockResolvedValue(LINKED),
      },
    });
    expect(session().discordUserId).toBeNull();
    const { back } = await link(req, sid, session().csrfToken);
    expect(back.headers.location).toBe('/host?link=already');
    expect(store.linkUnlessLinkedElsewhere).not.toHaveBeenCalled();
    expect(session()).toMatchObject({
      discordUserId: DISCORD_USER.id,
      tier: 'promoted',
    });
  });

  it('home shows the Link button to an unlinked host, and only fixed notices', async () => {
    const { req, sid, session } = await setup();
    const home = await req.get('/host').set('Cookie', sid);
    expect(home.text).toMatch(
      new RegExp(
        '<form method="post" action="/host/link/discord">\\s*' +
          '<input type="hidden" name="_csrf" value="[^"]+" />\\s*' +
          '<button type="submit">Verify on Discord</button>',
      ),
    );
    // No more sending hosts to Verify in the server for this.
    expect(home.text).not.toContain('<strong>Verify</strong>');
    const odd = await req
      .get(`/host?link=${encodeURIComponent('<script>x</script>')}`)
      .set('Cookie', sid);
    expect(odd.text).not.toContain('<script>x');
    expect(odd.text).not.toContain('note attn');
    const taken = await req.get('/host?link=meetup-taken').set('Cookie', sid);
    expect(taken.text).toContain(
      'Your Meetup account is already linked to a different Discord account',
    );
    expect(session().csrfToken).toBeTruthy();
  });
});

describe('Verify on Discord: joining the server and running Verify', () => {
  const SUMMARY = {
    meetupName: 'Ann <b>Nguyen</b>',
    meetupMemberUrl: 'https://www.meetup.com/members/4242/',
    rolesGranted: ['Guest Host'],
    hostedCount: 3,
    attendedCount: 12,
  };

  async function verifySetup(
    options: {
      join?: { joined: boolean; pending: boolean } | Error;
      verify?: typeof SUMMARY | Error;
      /** A member token store, with these sets already in it. */
      tokens?: Record<string, { accessToken: string }>;
      rows?: MemberRecord[];
    } = {},
  ) {
    const kept = new Map(Object.entries(options.tokens ?? {}));
    function keyOf(owner: string | { meetup: string }): string {
      return typeof owner === 'string'
        ? `discord:${owner}`
        : `meetup:${owner.meetup}`;
    }
    const meetupTokens = options.tokens
      ? {
          keep: vi.fn(
            async (
              owner: string | { meetup: string },
              t: { accessToken: string },
            ) => {
              kept.set(keyOf(owner), t);
            },
          ),
          usable: vi.fn(async (owner: string | { meetup: string }) =>
            kept.get(keyOf(owner)),
          ),
          move: vi.fn(
            async (
              from: string | { meetup: string },
              to: string | { meetup: string },
            ) => {
              const t = kept.get(keyOf(from));
              if (t) {
                kept.set(keyOf(to), t);
                kept.delete(keyOf(from));
              }
            },
          ),
          forget: vi.fn(async (owner: string | { meetup: string }) => {
            kept.delete(keyOf(owner));
          }),
        }
      : undefined;
    const joinServer = vi.fn(async () => {
      if (options.join instanceof Error) {
        throw options.join;
      }
      return options.join ?? { joined: false, pending: false };
    });
    const runVerify = vi.fn(async () => {
      if (options.verify instanceof Error) {
        throw options.verify;
      }
      return options.verify ?? SUMMARY;
    });
    const discordVerifyUrl = vi.fn(
      (state: string) =>
        `https://discord.com/oauth2/authorize?scope=identify+guilds.join&state=${state}`,
    );
    const app = await setup({
      rows: options.rows,
      overrides: {
        joinServer,
        runVerify,
        discordVerifyUrl,
        ...(meetupTokens ? { meetupTokens } : {}),
      },
    });
    return {
      ...app,
      joinServer,
      runVerify,
      discordVerifyUrl,
      meetupTokens,
      kept,
    };
  }

  /** Discord's step, then Meetup's: returns the result page. */
  async function verify(
    app: Awaited<ReturnType<typeof verifySetup>>,
    meetupParams: (state: string) => string = (state) =>
      `state=${state}&code=m`,
  ) {
    const { back } = await link(app.req, app.sid, app.session().csrfToken);
    // On to Meetup with a sealed, session-bound verify cookie.
    const meetup = locationOf(back);
    expect(meetup.origin + meetup.pathname).toBe(
      'https://secure.meetup.com/oauth2/authorize',
    );
    const state = meetup.searchParams.get('state') ?? '';
    const cookie = setCookie(back, 'host_oauth_meetup') ?? '';
    expect(cookie).toBeTruthy();
    return app.req
      .get(`/host/auth/meetup/complete?${meetupParams(state)}`)
      .set('Cookie', `${app.sid}; ${cookie}`);
  }

  it('asks Discord for guilds.join, links, and runs Verify with the fresh Meetup token', async () => {
    const app = await verifySetup();
    const page = await verify(app);
    expect(app.discordVerifyUrl).toHaveBeenCalled();
    expect(app.joinServer).toHaveBeenCalledWith(
      DISCORD_USER.id,
      'discord-access',
    );
    expect(app.runVerify).toHaveBeenCalledWith(
      'meetup-access',
      DISCORD_USER.id,
    );
    expect(page.status).toBe(200);
    expect(page.text).toContain('You are verified');
    expect(page.text).toContain('Guest Host');
    expect(page.text).toContain('12 attended · 3 hosted — badges applied');
    expect(page.text).toContain('href="https://www.meetup.com/members/4242/"');
    // Host-supplied text is escaped.
    expect(page.text).not.toContain('<b>Nguyen</b>');
    // Already in the server: no join note, and no "joined" field.
    expect(page.text).not.toContain('We added you');
    expect(JSON.stringify(vi.mocked(app.deps.audit).mock.calls)).not.toContain(
      'Joined the server',
    );
    // Same-origin only: no form posts anywhere else.
    for (const [, action] of page.text.matchAll(
      /<form[^>]*action="([^"]+)"/g,
    )) {
      expect(action.startsWith('/host/')).toBe(true);
    }
  });

  it('adds a non-member to the server and asks them to accept the rules', async () => {
    const app = await verifySetup({ join: { joined: true, pending: true } });
    const page = await verify(app);
    expect(page.text).toContain('accept the server rules');
    expect(JSON.stringify(vi.mocked(app.deps.audit).mock.calls)).toContain(
      'Joined the server',
    );
  });

  it('a join Discord refuses keeps the link, alerts, and stops before Meetup', async () => {
    const app = await verifySetup({ join: new Error('missing access') });
    const { back } = await link(app.req, app.sid, app.session().csrfToken);
    expect(app.store.linkUnlessLinkedElsewhere).toHaveBeenCalledOnce();
    expect(JSON.stringify(app.alert.mock.calls)).toContain(
      'Could not add a member to the server (host dashboard)',
    );
    // Every Verify step needs them in the server: no Meetup step, no run.
    expect(back.status).toBe(200);
    expect(setCookie(back, 'host_oauth_meetup')).toBeUndefined();
    expect(back.text).toContain('Linked, not in our server yet');
    expect(app.runVerify).not.toHaveBeenCalled();
  });

  it('roles that fail after the link keep the link, alert, and point to Verify in Discord', async () => {
    const app = await verifySetup({ verify: new Error('discord 500') });
    const page = await verify(app);
    expect(app.store.linkUnlessLinkedElsewhere).toHaveBeenCalledOnce();
    expect(page.text).toContain('Linked, not verified yet');
    expect(page.text).toContain('press Verify in our Discord server');
    expect(page.text).toContain('action="/host/verify/finish"');
    expect(JSON.stringify(app.alert.mock.calls)).toContain(
      'Verify on the host dashboard did not finish',
    );
  });

  it('a non-member is told why, with no second alert', async () => {
    const app = await verifySetup({
      verify: new NonMemberError("You're not a member of our Meetup group."),
    });
    const page = await verify(app);
    expect(page.text).toContain('Not verified');
    expect(page.text).toContain('not a member of our Meetup group');
    // After joining the group on Meetup, they can finish here.
    expect(page.text).toContain('action="/host/verify/finish"');
    expect(JSON.stringify(app.alert.mock.calls)).not.toContain(
      'did not finish',
    );
  });

  it('a different Meetup account at the Meetup step verifies nothing', async () => {
    const app = await verifySetup();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a vi.fn
    vi.mocked(app.deps.meetup.fetchSelf).mockResolvedValueOnce({
      id: '9999',
      name: 'Someone else',
    });
    const page = await verify(app);
    expect(page.status).toBe(403);
    expect(page.text).toContain('A different Meetup account');
    expect(app.runVerify).not.toHaveBeenCalled();
    expect(JSON.stringify(app.alert.mock.calls)).toContain(
      'a different Meetup account',
    );
  });

  it('cancelling at Meetup leaves them linked, with a way to try again', async () => {
    const app = await verifySetup();
    const page = await verify(
      app,
      (state) => `state=${state}&error=access_denied`,
    );
    expect(page.text).toContain('Linked, not verified yet');
    expect(page.text).toContain('action="/host/verify/finish"');
    expect(app.runVerify).not.toHaveBeenCalled();
  });

  /** "Finish verification": straight to Meetup's step, returns its page and cookie. */
  async function finish(app: Awaited<ReturnType<typeof verifySetup>>) {
    const start = await app.req
      .post('/host/verify/finish')
      .set('Cookie', app.sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: app.session().csrfToken });
    expect(start.status).toBe(200);
    const href =
      /<a class="button" href="([^"]+)">Continue to Meetup<\/a>/.exec(
        start.text,
      )?.[1];
    const url = new URL((href ?? '').replace(/&amp;/g, '&'));
    expect(url.origin + url.pathname).toBe(
      'https://secure.meetup.com/oauth2/authorize',
    );
    return {
      state: url.searchParams.get('state') ?? '',
      cookie: setCookie(start, 'host_oauth_meetup') ?? '',
    };
  }

  it('Finish verification resumes at Meetup without redoing Discord', async () => {
    const app = await verifySetup();
    await verify(app, (state) => `state=${state}&error=access_denied`);
    expect(app.runVerify).not.toHaveBeenCalled();
    const { state, cookie } = await finish(app);
    const page = await app.req
      .get(`/host/auth/meetup/complete?state=${state}&code=m`)
      .set('Cookie', `${app.sid}; ${cookie}`);
    expect(page.text).toContain('You are verified');
    expect(app.runVerify).toHaveBeenCalledWith(
      'meetup-access',
      DISCORD_USER.id,
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a vi.fn
    expect(vi.mocked(app.deps.discord.exchangeCode)).toHaveBeenCalledTimes(1);
  });

  it('Finish verification needs a linked Meetup sign-in', async () => {
    const app = await verifySetup();
    const res = await app.req
      .post('/host/verify/finish')
      .set('Cookie', app.sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: app.session().csrfToken });
    // Not linked yet: back home, no Meetup cookie.
    expect(res.status).toBe(303);
    expect(setCookie(res, 'host_oauth_meetup')).toBeUndefined();
  });

  it('one Verify run at a time: a double click waits for the run and shows its result', async () => {
    let release: (() => void) | undefined;
    let outcome: typeof SUMMARY | Error = SUMMARY;
    const app = await verifySetup();
    await verify(app, (state) => `state=${state}&error=access_denied`);
    app.runVerify.mockImplementation(
      async () =>
        new Promise((resolve, reject) => {
          release = () => {
            if (outcome instanceof Error) {
              reject(outcome);
            } else {
              resolve(outcome);
            }
          };
        }),
    );
    const complete = async (flow: { state: string; cookie: string }) =>
      // Sent now (the request is lazy until awaited or then'd).
      Promise.resolve(
        app.req
          .get(`/host/auth/meetup/complete?state=${flow.state}&code=m`)
          .set('Cookie', `${app.sid}; ${flow.cookie}`),
      );
    const one = complete(await finish(app));
    await vi.waitFor(() => {
      expect(app.runVerify).toHaveBeenCalledTimes(1);
    });
    const two = complete(await finish(app));
    // Let the second request reach the server and wait on the first run.
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    release?.();
    const [first, second] = await Promise.all([one, two]);
    expect(first.text).toContain('You are verified');
    expect(second.text).toContain('You are verified');
    expect(app.runVerify).toHaveBeenCalledTimes(1);
    // A failure is shown to both, never "it worked".
    app.runVerify.mockClear();
    outcome = new Error('discord 500');
    const three = complete(await finish(app));
    await vi.waitFor(() => {
      expect(app.runVerify).toHaveBeenCalledTimes(1);
    });
    const four = complete(await finish(app));
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    release?.();
    const [failed, waited] = await Promise.all([three, four]);
    expect(failed.text).toContain('Linked, not verified yet');
    expect(waited.text).toContain('Linked, not verified yet');
    expect(app.runVerify).toHaveBeenCalledTimes(1);
  });

  it('a join refused for too many servers says to leave one first, with the code in the alert', async () => {
    const tooMany = new DiscordAPIError(
      {
        code: RESTJSONErrorCodes.MaximumNumberOfGuildsReached,
        message: 'Maximum number of guilds reached (100)',
      },
      RESTJSONErrorCodes.MaximumNumberOfGuildsReached,
      400,
      'PUT',
      '/guilds/g/members/u',
      {},
    );
    const app = await verifySetup({ join: tooMany });
    const { back } = await link(app.req, app.sid, app.session().csrfToken);
    expect(back.text).toContain('Leave a server first');
    expect(JSON.stringify(app.alert.mock.calls)).toContain(
      String(RESTJSONErrorCodes.MaximumNumberOfGuildsReached),
    );
    // A retry (from a session that never learned the link) posts no
    // second alert within the hour.
    patchStoredSession(app.cache, { discordUserId: null });
    await link(app.req, app.sid, app.session().csrfToken);
    expect(
      app.alert.mock.calls.filter(([e]) =>
        JSON.stringify(e).includes('Could not add a member to the server'),
      ),
    ).toHaveLength(1);
  });

  it('a Meetup account linked to someone else gets no Finish button', async () => {
    const app = await verifySetup({
      verify: new DuplicateMeetupAccountError(
        'That Meetup account is already linked to another Discord account.',
      ),
    });
    const page = await verify(app);
    expect(page.text).toContain('Not verified');
    expect(page.text).not.toContain('action="/host/verify/finish"');
  });

  it("a host refused at the gate's re-check loses the set kept at sign-in", async () => {
    let clock = Date.now();
    const forget = vi.fn().mockResolvedValue(undefined);
    const app = await setup({
      overrides: {
        now: () => clock,
        meetupTokens: {
          keep: vi.fn().mockResolvedValue(undefined),
          usable: vi.fn(),
          move: vi.fn(),
          forget,
        },
      },
    });
    app.resolve.mockResolvedValue({ kind: 'refused', reason: 'not-a-host' });
    clock += ROLE_RECHECK_MS + 1000;
    const res = await app.req.get('/host').set('Cookie', app.sid);
    expect(res.status).toBe(403);
    expect(forget).toHaveBeenCalledWith({ meetup: MEETUP_SELF.id });
  });

  it('a host refused at sign-in loses the set kept at an earlier sign-in', async () => {
    const forget = vi.fn().mockResolvedValue(undefined);
    const app = await setup({
      overrides: {
        meetupTokens: {
          keep: vi.fn().mockResolvedValue(undefined),
          usable: vi.fn(),
          move: vi.fn(),
          forget,
        },
      },
    });
    app.resolve.mockResolvedValue({ kind: 'refused', reason: 'not-a-host' });
    await expect(signInWithMeetup(app.req)).rejects.toThrow();
    expect(forget).toHaveBeenCalledWith({ meetup: MEETUP_SELF.id });
  });

  it('a non-member keeps the link and is told why', async () => {
    const app = await verifySetup({
      verify: new NonMemberError("You're not a member of our Meetup group."),
    });
    await verify(app);
    expect(
      app.store.rows.some(
        (r) =>
          r.meetupId === MEETUP_SELF.id && r.discordUserId === DISCORD_USER.id,
      ),
    ).toBe(true);
  });

  it('keeps the Meetup token at sign-in and Verifies with it, without a Meetup step', async () => {
    // Store wired, empty before sign-in: the sign-in fills it.
    const app = await verifySetup({ tokens: {} });
    expect(app.kept.get(`meetup:${MEETUP_SELF.id}`)).toMatchObject({
      accessToken: 'meetup-access',
      refreshToken: 'meetup-refresh',
    });
    const { back } = await link(app.req, app.sid, app.session().csrfToken);
    // Straight to the result page from Discord's step.
    expect(back.status).toBe(200);
    expect(setCookie(back, 'host_oauth_meetup')).toBeUndefined();
    expect(back.text).toContain('You are verified');
    expect(app.runVerify).toHaveBeenCalledWith(
      'meetup-access',
      DISCORD_USER.id,
    );
    // Once linked, the set lives under the Discord id, as the bot keeps it.
    expect(app.kept.has(`meetup:${MEETUP_SELF.id}`)).toBe(false);
    expect(app.kept.get(`discord:${DISCORD_USER.id}`)).toBeDefined();
  });

  it('a sign-in already linked keeps its set under the Discord id, for the bot too', async () => {
    const app = await verifySetup({ tokens: {}, rows: [member({})] });
    expect(app.kept.get(`discord:${DISCORD_USER.id}`)).toMatchObject({
      accessToken: 'meetup-access',
    });
    expect(app.kept.has(`meetup:${MEETUP_SELF.id}`)).toBe(false);
  });

  it('a set already under the Discord id is used first', async () => {
    const app = await verifySetup({
      tokens: { [`discord:${DISCORD_USER.id}`]: { accessToken: 'bot-token' } },
    });
    const { back } = await link(app.req, app.sid, app.session().csrfToken);
    expect(back.text).toContain('You are verified');
    expect(app.runVerify).toHaveBeenCalledWith('bot-token', DISCORD_USER.id);
  });

  it('a set under the Discord id for ANOTHER Meetup account is never used', async () => {
    const app = await verifySetup({
      tokens: {
        [`discord:${DISCORD_USER.id}`]: { accessToken: 'other-account' },
      },
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a vi.fn
    vi.mocked(app.deps.meetup.fetchSelf).mockImplementation(async (token) => {
      if (token === 'other-account') {
        return { id: '9999', name: 'Someone else' };
      }
      return MEETUP_SELF;
    });
    // The host's own set from sign-in passes the check and is used; the
    // other account's set is skipped, then replaced by the host's.
    const { back } = await link(app.req, app.sid, app.session().csrfToken);
    expect(back.text).toContain('You are verified');
    expect(app.runVerify).toHaveBeenCalledTimes(1);
    expect(app.runVerify).toHaveBeenCalledWith(
      'meetup-access',
      DISCORD_USER.id,
    );
    expect(app.kept.get(`discord:${DISCORD_USER.id}`)).toMatchObject({
      accessToken: 'meetup-access',
    });
    // With no own set either: the Meetup step, never the other account's.
    app.runVerify.mockClear();
    app.kept.clear();
    app.kept.set(`discord:${DISCORD_USER.id}`, {
      accessToken: 'other-account',
    });
    const page = await app.req
      .post('/host/verify/finish')
      .set('Cookie', app.sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: app.session().csrfToken });
    expect(page.text).toContain('Continue to Meetup');
    expect(app.runVerify).not.toHaveBeenCalled();
  });

  it('a move that fails still uses the good token', async () => {
    const app = await verifySetup({ tokens: {} });
    app.meetupTokens?.move.mockRejectedValue(new Error('redis down'));
    const { back } = await link(app.req, app.sid, app.session().csrfToken);
    expect(back.text).toContain('You are verified');
    expect(app.runVerify).toHaveBeenCalledWith(
      'meetup-access',
      DISCORD_USER.id,
    );
  });

  it('a sign-in whose set cannot be kept still signs in', async () => {
    const keep = vi.fn().mockRejectedValue(new Error('redis down'));
    const app = await setup({
      overrides: {
        meetupTokens: {
          keep,
          usable: vi.fn(),
          move: vi.fn(),
          forget: vi.fn(),
        },
      },
    });
    expect(keep).toHaveBeenCalled();
    expect((await app.req.get('/host').set('Cookie', app.sid)).status).toBe(
      200,
    );
  });

  it('Finish verification finds the link when an outage kept it out of the session', async () => {
    const app = await verifySetup();
    // Linked in the store, but the session never learned it.
    app.store.rows.push(member({}));
    const res = await app.req
      .post('/host/verify/finish')
      .set('Cookie', app.sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: app.session().csrfToken });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Continue to Meetup');
  });

  it('a host refused at the Discord step loses the set kept at sign-in', async () => {
    const app = await verifySetup({ tokens: {} });
    expect(app.kept.has(`meetup:${MEETUP_SELF.id}`)).toBe(true);
    app.resolve.mockResolvedValue({ kind: 'refused', reason: 'blacklisted' });
    const { back } = await link(app.req, app.sid, app.session().csrfToken);
    expect(back.status).toBe(403);
    expect(app.kept.has(`meetup:${MEETUP_SELF.id}`)).toBe(false);
  });

  it('no usable set (none kept, or its refresh failed): the Meetup step, which keeps the new one', async () => {
    const app = await verifySetup({ tokens: {} });
    // As if the kept set expired and Meetup refused its refresh.
    app.kept.clear();
    const page = await verify(app);
    expect(page.text).toContain('You are verified');
    expect(app.runVerify).toHaveBeenCalledWith(
      'meetup-access',
      DISCORD_USER.id,
    );
    expect(app.kept.get(`discord:${DISCORD_USER.id}`)).toMatchObject({
      accessToken: 'meetup-access',
    });
  });

  it('a store that cannot answer falls back to the Meetup step', async () => {
    const app = await verifySetup({ tokens: {} });
    app.meetupTokens?.usable.mockRejectedValue(new Error('redis down'));
    const page = await verify(app);
    expect(page.text).toContain('You are verified');
  });

  it('Finish verification with a kept set runs at once', async () => {
    const app = await verifySetup({ tokens: {} });
    app.kept.clear();
    await verify(app, (state) => `state=${state}&error=access_denied`);
    app.kept.set(`discord:${DISCORD_USER.id}`, { accessToken: 'later' });
    const res = await app.req
      .post('/host/verify/finish')
      .set('Cookie', app.sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: app.session().csrfToken });
    expect(res.text).toContain('You are verified');
    expect(app.runVerify).toHaveBeenCalledWith('later', DISCORD_USER.id);
  });

  it('a member who was already linked but just joined the server is reported', async () => {
    const app = await verifySetup({
      join: { joined: true, pending: false },
      tokens: {},
    });
    app.store.rows.push(member({}));
    await link(app.req, app.sid, app.session().csrfToken);
    expect(JSON.stringify(vi.mocked(app.deps.audit).mock.calls)).toContain(
      'Joined the server (host dashboard)',
    );
  });

  it('only this flow asks guilds.join: a Discord sign-in uses the plain login URL', async () => {
    const app = await verifySetup();
    app.discordVerifyUrl.mockClear();
    await signInWithDiscord(app.req);
    expect(app.discordVerifyUrl).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a vi.fn
    expect(vi.mocked(app.deps.discord.buildLoginUrl)).toHaveBeenCalled();
  });

  it('a Meetup step that reaches a different session verifies nothing', async () => {
    const app = await verifySetup();
    const { back } = await link(app.req, app.sid, app.session().csrfToken);
    const state = locationOf(back).searchParams.get('state') ?? '';
    const cookie = setCookie(back, 'host_oauth_meetup') ?? '';
    const other = await signInWithMeetup(app.req);
    const page = await app.req
      .get(`/host/auth/meetup/complete?state=${state}&code=m`)
      .set('Cookie', `${other}; ${cookie}`);
    expect(page.headers.location).toBe('/host?link=error');
    expect(app.runVerify).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostResolution } from '../../../src/lib/hosts/eligibility.js';
import { WebLinkStore } from '../../../src/lib/hosts/webLink.js';
import {
  MeetupIdConflictError,
  MemberRecord,
} from '../../../src/lib/repositories/types.js';
import { HostRouterDeps } from '../../../src/web/host/hostRouter.js';
import { registerHostPages } from '../../../src/web/host/hostPages.js';
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
  const back = await req
    .get(`/host/auth/discord/callback?${callback(state)}`)
    .set('Cookie', `${sid}; ${oauth}`);
  return { state, back };
}

describe('Link your Discord account', () => {
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
    expect(home.text).toContain('Your Discord account is linked.');
    expect(home.text).not.toContain('Link your Discord account');
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

  it('home shows the Link button to an unlinked host, and only fixed notices', async () => {
    const { req, sid, session } = await setup();
    const home = await req.get('/host').set('Cookie', sid);
    expect(home.text).toMatch(
      new RegExp(
        '<form method="post" action="/host/link/discord">\\s*' +
          '<input type="hidden" name="_csrf" value="[^"]+" />\\s*' +
          '<button type="submit">Link your Discord account</button>',
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

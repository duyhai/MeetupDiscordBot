import { afterEach, describe, expect, it, vi } from 'vitest';

import { GUEST_HOST_MEETUP_BLACKLIST } from '../../../src/constants.js';

import { HostEvent } from '../../../src/lib/hosts/hostEvents.js';
import { PromotionCandidate } from '../../../src/lib/hosts/promotionCandidates.js';
import { PromotedHost } from '../../../src/lib/repositories/postgresPromotedHostRepository.js';
import { registerAllProtectedRoutes } from '../../../src/web/routes/dashboardPages.js';
import { PROMOTION_RESULT_MESSAGES } from '../../../src/web/routes/hostPromotion.js';
import {
  Client,
  ORIGIN,
  USER,
  closeServers,
  makeApp,
  signIn,
} from '../dashboardHarness.js';
import {
  PAGE_NOW,
  fakeOrganizerDeps,
  fakePageDeps,
  fakePromotedHosts,
} from './pageFakes.js';

afterEach(() => {
  vi.restoreAllMocks();
  return closeServers();
});

const PAGE = '/dashboard/hosts/promotion';
const HOST = '123456';
const MEMBER = `${PAGE}/${HOST}`;
const HOSTILE = '<script>alert(1)</script>"><img src=x>';

const pastEvent = (
  id: string,
  dateTime: string,
  name = 'Dee Host',
): HostEvent => ({
  id,
  title: `Board games ${id}`,
  dateTime,
  eventUrl: `https://www.meetup.com/g/events/${id}/`,
  type: 'games',
  counted: true,
  hosts: [{ id: HOST, name }],
});

const candidate = (
  id: string,
  pastCount: number,
  name = `Host ${id}`,
): PromotionCandidate => ({
  meetupMemberId: id,
  name,
  recentCount: pastCount,
  pastCount,
  memberSince: '2024-02-01T12:00:00-08:00',
  lastHosted: '2026-08-20T19:00:00-07:00',
});

const promotedRow = (overrides: Partial<PromotedHost> = {}): PromotedHost => ({
  meetupMemberId: HOST,
  active: true,
  reason: 'Ran 40 great events',
  changedBy: USER.id,
  changedAt: new Date('2026-08-01T00:00:00Z'),
  version: 1,
  ...overrides,
});

async function tokenOf(req: Client, cookie: string): Promise<string> {
  const home = await req.get('/dashboard').set('Cookie', cookie);
  const match = /name="_csrf" value="([^"]+)"/.exec(home.text);
  if (!match) {
    throw new Error('home page has no CSRF field');
  }
  return match[1];
}

async function setup(
  options: {
    leader?: boolean | Error;
    rows?: PromotedHost[];
    past?: HostEvent[];
    candidates?: PromotionCandidate[] | 'never';
    uncounted?: number;
    revoke?: Error;
  } = {},
) {
  const store = fakePromotedHosts(options.rows ?? []);
  const isLeadership = vi.fn<(id: string) => Promise<boolean>>(async () => {
    if (options.leader instanceof Error) {
      throw options.leader;
    }
    return options.leader ?? true;
  });
  const audit = vi.fn().mockResolvedValue(true);
  const hostAlert = vi.fn().mockResolvedValue(true);
  const revokeHostSessions = vi.fn(async () => {
    if (options.revoke) {
      throw options.revoke;
    }
  });
  const list = options.candidates ?? [];
  const promotionCandidates = vi.fn(async () => {
    if (list === 'never') {
      return new Promise<never>(() => undefined);
    }
    return {
      candidates: list,
      seen: new Map(
        list.map((c) => [
          c.meetupMemberId,
          {
            meetupMemberId: c.meetupMemberId,
            name: c.name,
            lastHosted: c.lastHosted,
          },
        ]),
      ),
      uncounted: options.uncounted ?? 0,
    };
  });
  // A host with one past event unless a test says otherwise.
  const hostPastEvents = vi.fn(
    async () => options.past ?? [pastEvent('1', '2026-01-10T19:00:00-08:00')],
  );
  const { req } = await makeApp({
    now: () => PAGE_NOW.getTime(),
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({
          isLeadership,
          audit,
          hostAlert,
          revokeHostSessions,
          promotedHosts: async () => store,
          promotionCandidates,
          hostPastEvents,
        }),
      }),
  });
  const cookie = await signIn(req);
  const token = await tokenOf(req, cookie);
  const get = (path: string) => req.get(path).set('Cookie', cookie);
  const post = (body: Record<string, string>, path = MEMBER) =>
    req
      .post(path)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: token, ...body });
  return {
    store,
    isLeadership,
    audit,
    hostAlert,
    revokeHostSessions,
    get,
    post,
    req,
    cookie,
  };
}

const resultOf = (location: string | undefined) =>
  new URL(location ?? '', 'http://x').searchParams.get('result');

describe('host promotion page', () => {
  it('lists Community Hosts, and candidates without the promoted ones, escaped', async () => {
    const { get } = await setup({
      rows: [promotedRow()],
      candidates: [
        candidate(HOST, 45, 'Dee Host'),
        candidate('777', 31, HOSTILE),
        candidate('888', 20),
      ],
    });
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).not.toContain('<img src=x>');
    expect(res.text).toContain('Community Hosts (1)');
    expect(res.text).toContain('Ran 40 great events');
    expect(res.text).toContain(`href="${PAGE}/777"`);
    expect(res.text).toContain(`href="${PAGE}/888"`);
    // The promoted host is listed once, in the Community Hosts table only.
    const candidates = res.text.slice(res.text.indexOf('<h2>Candidates'));
    expect(candidates).not.toContain(`href="${MEMBER}"`);
    expect(candidates.indexOf('/777"')).toBeLessThan(
      candidates.indexOf('/888"'),
    );
    expect(res.text).toContain('aria-current="page">Host promotion');
  });

  it('a slow Meetup still shows the Community Hosts and says to reload', async () => {
    const { get } = await setup({ rows: [promotedRow()], candidates: 'never' });
    const res = await get(PAGE);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Community Hosts (1)');
    expect(res.text).toContain('Reload in');
  }, 15_000);

  it('hosts Meetup gave no count for are noted, the rest still listed', async () => {
    const { get } = await setup({
      candidates: [candidate('777', 31)],
      uncounted: 2,
    });
    const res = await get(PAGE);
    expect(res.text).toMatch(/did not give the count for 2\s+hosts/);
    expect(res.text).toContain(`href="${PAGE}/777"`);
  });

  it('demoted hosts are listed apart, not deleted', async () => {
    const { get } = await setup({
      rows: [promotedRow({ active: false, reason: 'Stepped back' })],
    });
    const res = await get(PAGE);
    expect(res.text).toContain('Community Hosts (0)');
    expect(res.text).toContain('Demoted (1)');
    expect(res.text).toContain('Stepped back');
  });
});

describe('a host’s page', () => {
  const PAST = [
    pastEvent('3', '2026-08-20T19:00:00-07:00'),
    pastEvent('2', '2026-03-07T19:00:00-08:00'),
    pastEvent('1', '2025-11-01T19:00:00-07:00'),
  ];

  it('shows the count, the heat maps and the leader’s Promote form', async () => {
    const { get } = await setup({ past: PAST });
    const res = await get(MEMBER);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h1><bdi>Dee Host</bdi></h1>');
    expect(res.text).toMatch(/3 past hosted\s+events, last on Aug 20, 2026/);
    expect(res.text.match(/<svg/g)?.length).toBeGreaterThanOrEqual(2);
    expect(res.text).toContain(`action="${MEMBER}"`);
    expect(res.text).toContain('name="version" value="0"');
    expect(res.text).toMatch(/name="change"\s+value="promote"/);
    expect(res.text).toContain('Never promoted.');
  });

  it('a Community Host gets Demote, at the row’s version', async () => {
    const { get } = await setup({
      past: PAST,
      rows: [promotedRow({ version: 4 })],
    });
    const res = await get(MEMBER);
    expect(res.text).toMatch(/name="change"\s+value="demote"/);
    expect(res.text).toContain('name="version" value="4"');
  });

  it('a Moderator sees the page without the form', async () => {
    const { get } = await setup({ past: PAST, leader: false });
    const res = await get(MEMBER);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('name="change"');
    expect(res.text).toContain('Only the 1.5 Leadership Team');
  });

  it('a day on the map lists that day’s events', async () => {
    const { get } = await setup({ past: PAST });
    const res = await get(`${MEMBER}?day=2026-03-07`);
    expect(res.text).toContain('Events on Mar 7, 2026');
    expect(res.text).toContain('Board games 2');
    expect(res.text).not.toContain('Board games 3</a>');
  });

  it('a hostile name is escaped; an unknown or bad id is 404', async () => {
    const { get } = await setup({
      past: [pastEvent('1', '2026-01-01T19:00:00-08:00', HOSTILE)],
    });
    const res = await get(MEMBER);
    expect(res.text).not.toContain('<script>alert');
    const none = await setup({ past: [] });
    expect((await none.get(MEMBER)).status).toBe(404);
    expect((await none.get(`${PAGE}/0123`)).status).toBe(404);
  });
});

describe('promote and demote', () => {
  it('promote: recorded, the host signed out, logged and alerted with no pings', async () => {
    const app = await setup();
    const res = await app.post({
      change: 'promote',
      version: '0',
      reason: 'Hosted 30 events\r\nwith great reviews',
    });
    expect(res.status).toBe(303);
    expect(resultOf(res.headers.location)).toBe('promoted');
    expect(app.store.change).toHaveBeenCalledWith(
      'promote',
      HOST,
      0,
      USER.id,
      'Hosted 30 events\nwith great reviews',
    );
    expect(app.store.rows[0]).toMatchObject({ active: true, version: 1 });
    expect(app.revokeHostSessions).toHaveBeenCalledWith(HOST);
    expect(app.audit).toHaveBeenCalled();
    expect(app.hostAlert).toHaveBeenCalledTimes(1);
    const alert = JSON.stringify(app.hostAlert.mock.calls);
    expect(alert).toContain('Host promoted to Community Host');
    expect(alert).not.toContain('<@&');
    expect(alert).not.toMatch(/@everyone|@here/);
  });

  it('the page then shows the change, its reason and who made it', async () => {
    const app = await setup({
      past: [pastEvent('1', '2026-01-01T19:00:00-08:00')],
    });
    await app.post({ change: 'promote', version: '0', reason: 'Great host' });
    const res = await app.get(`${MEMBER}?result=promoted`);
    expect(res.text).toContain(PROMOTION_RESULT_MESSAGES.promoted.slice(0, 30));
    expect(res.text).toMatch(/Promoted\s*<\/td>/);
    expect(res.text).toContain('Great host');
    expect(res.text).toMatch(/name="change"\s+value="demote"/);
  });

  it('demote: recorded as a new version, nothing deleted', async () => {
    const app = await setup({ rows: [promotedRow({ version: 2 })] });
    const res = await app.post({
      change: 'demote',
      version: '2',
      reason: 'Complaints',
    });
    expect(resultOf(res.headers.location)).toBe('demoted');
    expect(app.store.rows).toEqual([
      expect.objectContaining({
        active: false,
        version: 3,
        reason: 'Complaints',
      }),
    ]);
    expect(JSON.stringify(app.hostAlert.mock.calls)).toContain(
      'Community Host demoted',
    );
  });

  it('a second leader acting on the same version gets 409 and changes nothing', async () => {
    const app = await setup({ rows: [promotedRow()] });
    await app.post({ change: 'demote', version: '1', reason: 'a' });
    const late = await app.post({
      change: 'demote',
      version: '1',
      reason: 'b',
    });
    expect(late.status).toBe(409);
    expect(late.text).toContain('Someone just changed this host');
    expect(app.hostAlert).toHaveBeenCalledTimes(1);
    expect(app.revokeHostSessions).toHaveBeenCalledTimes(1);
  });

  it('demoting someone never promoted, and promoting a Community Host, change nothing', async () => {
    const never = await setup();
    const res = await never.post({
      change: 'demote',
      version: '0',
      reason: 'x',
    });
    expect(resultOf(res.headers.location)).toBe('never-promoted');
    const already = await setup({ rows: [promotedRow()] });
    const again = await already.post({
      change: 'promote',
      version: '1',
      reason: 'x',
    });
    expect(resultOf(again.headers.location)).toBe('unchanged');
    expect(never.hostAlert).not.toHaveBeenCalled();
    expect(already.revokeHostSessions).not.toHaveBeenCalled();
  });

  it('a reason is required and capped; a bad change or version is invalid', async () => {
    const app = await setup();
    const cases: [Record<string, string>, string][] = [
      [
        { change: 'promote', version: '0', reason: '  \r\n ' },
        'reason-required',
      ],
      [
        { change: 'promote', version: '0', reason: 'x'.repeat(2001) },
        'reason-too-long',
      ],
      [{ change: 'crown', version: '0', reason: 'x' }, 'invalid'],
      [{ change: 'promote', version: '-1', reason: 'x' }, 'invalid'],
      [{ change: 'promote', reason: 'x' }, 'invalid'],
    ];
    // One at a time: each answer is checked against its own case.
    for (const [body, code] of cases) {
      // eslint-disable-next-line no-await-in-loop
      expect(resultOf((await app.post(body)).headers.location)).toBe(code);
    }
    expect(app.store.change).not.toHaveBeenCalled();
  });

  it('a Moderator is refused (once logged), and an unreachable Discord changes nothing', async () => {
    const mod = await setup({ leader: false });
    const res = await mod.post({
      change: 'promote',
      version: '0',
      reason: 'x',
    });
    expect(resultOf(res.headers.location)).toBe('not-leadership');
    await mod.post({ change: 'promote', version: '0', reason: 'x' });
    expect(mod.audit).toHaveBeenCalledTimes(1);
    expect(mod.store.change).not.toHaveBeenCalled();
    const down = await setup({ leader: new Error('discord down') });
    const res2 = await down.post({
      change: 'promote',
      version: '0',
      reason: 'x',
    });
    expect(resultOf(res2.headers.location)).toBe('leadership-unavailable');
    expect(down.store.change).not.toHaveBeenCalled();
  });

  it('a failed sign-out still records the change, and says it applies within 10 minutes', async () => {
    const app = await setup({ revoke: new Error('redis down') });
    const res = await app.post({
      change: 'promote',
      version: '0',
      reason: 'x',
    });
    expect(resultOf(res.headers.location)).toBe('promoted-no-signout');
    expect(app.store.rows).toHaveLength(1);
    const page = await app.get(res.headers.location ?? '');
    expect(page.text).toContain('applies within 10 minutes');
    expect(page.text).not.toContain('so it takes effect now');
  });

  it('someone the page would 404 (no row, history or past event) is 404 on POST too', async () => {
    const app = await setup({ past: [] });
    const res = await app.post({
      change: 'promote',
      version: '0',
      reason: 'x',
    });
    expect(res.status).toBe(404);
    expect(app.store.change).not.toHaveBeenCalled();
  });

  it('a blacklisted host cannot be promoted', async () => {
    const app = await setup();
    const res = await app.post(
      { change: 'promote', version: '0', reason: 'x' },
      `${PAGE}/${GUEST_HOST_MEETUP_BLACKLIST[0]}`,
    );
    expect(resultOf(res.headers.location)).toBe('blacklisted');
    expect(app.store.change).not.toHaveBeenCalled();
  });

  it('a store failure says it did not save', async () => {
    const app = await setup();
    app.store.change.mockRejectedValueOnce(new Error('pg down'));
    const res = await app.post({
      change: 'promote',
      version: '0',
      reason: 'x',
    });
    expect(resultOf(res.headers.location)).toBe('error');
    expect(app.hostAlert).not.toHaveBeenCalled();
  });

  it('without the CSRF token: 403, nothing changed', async () => {
    const app = await setup();
    const res = await app.req
      .post(MEMBER)
      .set('Cookie', app.cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ change: 'promote', version: '0', reason: 'x' });
    expect(res.status).toBe(403);
    expect(app.store.change).not.toHaveBeenCalled();
  });
});

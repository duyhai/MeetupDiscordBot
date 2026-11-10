/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.objectContaining() matchers */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LogEntry } from '../../../src/lib/helpers/discordLogger.js';
import { WrappedAnnouncementRecord } from '../../../src/lib/repositories/postgresWrappedAnnouncementRepository.js';
import { WrappedAnnounceOutcome } from '../../../src/lib/wrapped/announce.js';
import {
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from '../../../src/web/routes/dashboardPages.js';
import { renderHomeReports } from '../../../src/web/routes/home.js';
import {
  WRAPPED_ANNOUNCE_PATH,
  WRAPPED_NOTICES,
} from '../../../src/web/routes/wrappedAnnounce.js';
import {
  Client,
  ORIGIN,
  USER,
  closeServers,
  makeApp,
  signIn,
} from '../dashboardHarness.js';
import { fakeOrganizerDeps, fakePageDeps } from './pageFakes.js';

afterEach(closeServers);

const CHANNEL = '123456789012345678';
const MESSAGE = '987654321098765432';
const CONFIG = { date: '2026-12-01', hour: 17, channelId: CHANNEL };

const posted: WrappedAnnouncementRecord = {
  year: 2026,
  claimedAt: new Date('2026-12-02T01:05:00Z'),
  postedAt: new Date('2026-12-02T01:05:30Z'),
  channelId: CHANNEL,
  messageId: MESSAGE,
};

function control(
  overrides: Partial<DashboardPageDeps['wrappedAnnounce']> = {},
): DashboardPageDeps['wrappedAnnounce'] {
  return {
    config: () => CONFIG,
    status: vi.fn(async () => undefined),
    postNow: vi.fn(async (): Promise<WrappedAnnounceOutcome> => 'posted'),
    ...overrides,
  };
}

/** Markup whitespace collapsed, so assertions read the sentence, not the formatting. */
const render = async (
  wrappedAnnounce: DashboardPageDeps['wrappedAnnounce'],
  view: { csrfToken?: string; notice?: unknown } = { csrfToken: 'tok' },
) =>
  (await renderHomeReports(fakePageDeps({ wrappedAnnounce }), view)).value
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><');

describe('Home Wrapped card', () => {
  it('shows the configured date, hour and channel, and that this year is not posted yet, with Post now', async () => {
    const out = await render(control());
    expect(out).toContain('<h2>Wrapped announcement</h2>');
    expect(out).toContain('Dec 1, 2026 5:00 PM Pacific');
    expect(out).toContain(`channel ${CHANNEL}`);
    expect(out).toContain('Not posted yet for 2026.');
    expect(out).toContain(`action="${WRAPPED_ANNOUNCE_PATH}"`);
    expect(out).toContain('name="_csrf" value="tok"');
    expect(out).toContain('>Post now</button>');
    expect(out).toContain('1.5 Leadership Team only');
  });

  it('shows when and where it was posted, with no Post now button', async () => {
    const out = await render(control({ status: async () => posted }));
    expect(out).toContain('Posted Dec 1, 2026 5:05 PM Pacific');
    expect(out).toContain(`message ${MESSAGE}`);
    expect(out).not.toContain('Post now');
    expect(out).not.toContain('Not posted yet');
  });

  it('a claim in progress (not yet posted) still offers Post now, since it is idempotent', async () => {
    const out = await render(
      control({
        status: async () => ({
          ...posted,
          postedAt: undefined,
          messageId: undefined,
        }),
      }),
    );
    expect(out).toContain('Not posted yet for 2026.');
    expect(out).toContain('Post now');
  });

  it('with no channel configured, says so and offers no button', async () => {
    const out = await render(
      control({ config: () => ({ ...CONFIG, channelId: undefined }) }),
    );
    expect(out).toContain('WRAPPED_ANNOUNCE_CHANNEL_ID');
    expect(out).toContain('not set');
    expect(out).not.toContain('Post now');
  });

  it('with a malformed date, says so and offers no button', async () => {
    const out = await render(
      control({ config: () => ({ ...CONFIG, date: undefined }) }),
    );
    expect(out).toContain('WRAPPED_ANNOUNCE_DATE');
    expect(out).toContain('not a real date');
    expect(out).not.toContain('Post now');
    expect(out).not.toContain('Not posted yet');
  });

  it('renders a known notice code and nothing for an unknown one', async () => {
    const out = await render(control(), { csrfToken: 'tok', notice: 'posted' });
    expect(out).toContain(WRAPPED_NOTICES.posted);
    const none = await render(control(), {
      csrfToken: 'tok',
      notice: '<script>alert(1)</script>',
    });
    expect(none).not.toContain('<script>');
    expect(none).not.toContain('alert(1)');
  });

  it('a failing status degrades the card alone, with no error text', async () => {
    const out = await render(
      control({
        status: async () => {
          throw new Error('db down: secret');
        },
      }),
    );
    expect(out).toContain('Unavailable right now.');
    expect(out).not.toContain('secret');
    expect(out).toContain('identity changes in the last 7 days');
  });

  it('without a CSRF token (a bare render) there is no form', async () => {
    const out = await render(control(), {});
    expect(out).not.toContain('<form');
    expect(out).toContain('Not posted yet for 2026.');
  });
});

async function setup(
  overrides: Partial<DashboardPageDeps['wrappedAnnounce']> = {},
) {
  const isLeadership = vi.fn<(id: string) => Promise<boolean>>();
  const audit = vi.fn<(entry: LogEntry) => Promise<unknown>>(async () => true);
  const postNow = vi.fn(async (): Promise<WrappedAnnounceOutcome> => 'posted');
  const wrappedAnnounce = control({ postNow, ...overrides });
  const pages = fakePageDeps({ isLeadership, audit, wrappedAnnounce });
  const { req } = await makeApp({
    audit,
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, { organizer: fakeOrganizerDeps(), pages }),
    homeReports: (view) => renderHomeReports(pages, view),
  });
  return { req, isLeadership, audit, postNow };
}

async function tokenOf(req: Client, cookie: string): Promise<string> {
  const page = await req.get('/dashboard').set('Cookie', cookie);
  expect(page.status).toBe(200);
  return /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
}

async function pressPostNow(req: Client, cookie: string) {
  return req
    .post(WRAPPED_ANNOUNCE_PATH)
    .set('Cookie', cookie)
    .set('Origin', ORIGIN)
    .type('form')
    .send({ _csrf: await tokenOf(req, cookie) });
}

describe('POST /dashboard/wrapped/announce', () => {
  it('needs the 1.5 Leadership Team role, checked live', async () => {
    const { req, isLeadership, postNow } = await setup();
    isLeadership.mockResolvedValue(false);
    const res = await pressPostNow(req, await signIn(req));
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/dashboard?wrapped=not-leadership');
    expect(isLeadership).toHaveBeenCalledWith(USER.id);
    expect(postNow).not.toHaveBeenCalled();
  });

  it('Leadership posts now; the outcome comes back as a notice on the home page', async () => {
    const { req, isLeadership, postNow, audit } = await setup();
    isLeadership.mockResolvedValue(true);
    const cookie = await signIn(req);
    const res = await pressPostNow(req, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/dashboard?wrapped=posted');
    expect(postNow).toHaveBeenCalledTimes(1);
    const home = await req
      .get('/dashboard?wrapped=posted')
      .set('Cookie', cookie);
    expect(home.text).toContain(WRAPPED_NOTICES.posted);
    // Audited in the activity log, naming who pressed it: no post text.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Wrapped announcement posted',
        description: expect.stringContaining(`<@${USER.id}>`),
      }),
    );
  });

  it.each(['already-posted', 'in-progress', 'failed', 'disabled'] as const)(
    'relays the outcome %s as its own notice',
    async (outcome) => {
      const { req, isLeadership, audit } = await setup({
        postNow: async () => outcome,
      });
      isLeadership.mockResolvedValue(true);
      const res = await pressPostNow(req, await signIn(req));
      expect(res.headers.location).toBe(`/dashboard?wrapped=${outcome}`);
      expect(audit).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Wrapped announcement posted' }),
      );
    },
  );

  it('a Discord failure on the role check changes nothing', async () => {
    const { req, isLeadership, postNow } = await setup();
    isLeadership.mockRejectedValue(new Error('discord down'));
    const res = await pressPostNow(req, await signIn(req));
    expect(res.headers.location).toBe('/dashboard?wrapped=unavailable');
    expect(postNow).not.toHaveBeenCalled();
  });

  it('a store failure answers error, with nothing from it on the page', async () => {
    const { req, isLeadership } = await setup({
      postNow: async () => {
        throw new Error('no pool: secret');
      },
    });
    isLeadership.mockResolvedValue(true);
    const cookie = await signIn(req);
    const res = await pressPostNow(req, cookie);
    expect(res.headers.location).toBe('/dashboard?wrapped=error');
    const home = await req
      .get('/dashboard?wrapped=error')
      .set('Cookie', cookie);
    expect(home.text).toContain(WRAPPED_NOTICES.error);
    expect(home.text).not.toContain('secret');
  });

  it('requires CSRF', async () => {
    const { req, isLeadership, postNow } = await setup();
    isLeadership.mockResolvedValue(true);
    const res = await req
      .post(WRAPPED_ANNOUNCE_PATH)
      .set('Cookie', await signIn(req))
      .set('Origin', ORIGIN)
      .type('form')
      .send({});
    expect(res.status).toBe(403);
    expect(postNow).not.toHaveBeenCalled();
  });

  it('the notice map covers every outcome and the route’s own codes', () => {
    expect(Object.keys(WRAPPED_NOTICES).sort()).toEqual(
      [
        'already-posted',
        'disabled',
        'error',
        'failed',
        'in-progress',
        'not-due',
        'not-leadership',
        'posted',
        'unavailable',
      ].sort(),
    );
  });
});

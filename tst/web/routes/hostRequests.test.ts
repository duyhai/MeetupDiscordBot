import { afterEach, describe, expect, it, vi } from 'vitest';

import { PublishOutcome } from '../../../src/lib/hosts/publishRequest.js';
import { EventRequest } from '../../../src/lib/repositories/postgresEventRequestRepository.js';
import { registerAllProtectedRoutes } from '../../../src/web/routes/dashboardPages.js';
import { HOST_REQUEST_RESULT_MESSAGES } from '../../../src/web/routes/hostRequests.js';
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
  eventRequestRow,
  fakeEventRequests,
  fakeOrganizerDeps,
  fakePageDeps,
} from './pageFakes.js';

afterEach(() => {
  vi.restoreAllMocks();
  return closeServers();
});

const QUEUE = '/dashboard/hosts/requests';
const HOSTILE = '<script>alert(1)</script>"><img src=x>';

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
    rows?: EventRequest[];
    publish?: (
      id: string,
      version: number,
      actor: string,
    ) => Promise<PublishOutcome>;
  } = {},
) {
  const store = fakeEventRequests(options.rows ?? [eventRequestRow()]);
  const isLeadership = vi.fn<(id: string) => Promise<boolean>>(async () => {
    if (options.leader instanceof Error) {
      throw options.leader;
    }
    return options.leader ?? true;
  });
  const publishRequest = vi.fn(
    options.publish ??
      (async (): Promise<PublishOutcome> => ({
        code: 'published',
        request: eventRequestRow({ status: 'published' }),
      })),
  );
  const audit = vi.fn().mockResolvedValue(true);
  const { req } = await makeApp({
    now: () => PAGE_NOW.getTime(),
    protectedRoutes: (r) =>
      registerAllProtectedRoutes(r, {
        organizer: fakeOrganizerDeps(),
        pages: fakePageDeps({
          isLeadership,
          audit,
          eventRequests: async () => store,
          publishRequest,
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
  return { store, isLeadership, publishRequest, audit, get, post };
}

describe('host request queue', () => {
  it('lists waiting requests with the leader’s buttons, escaped', async () => {
    const { get } = await setup({
      rows: [eventRequestRow({ title: HOSTILE, hostName: HOSTILE })],
    });
    const res = await get(QUEUE);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).not.toContain('<img src=x>');
    expect(res.text).toContain('Waiting (1)');
    expect(res.text).toContain('Approve and publish');
    expect(res.text).toContain(`action="${QUEUE}/1/deny"`);
    expect(res.text).toContain('name="version" value="1"');
    expect(res.text).toContain('aria-current="page">Host requests');
  });

  it('a Moderator sees the queue without buttons', async () => {
    const { get } = await setup({ leader: false });
    const res = await get(QUEUE);
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      'Only the 1.5 Leadership Team can approve or deny.',
    );
    expect(res.text).not.toContain('Approve and publish');
  });

  it('shows failed and long-stuck requests with Retry, but not a fresh publish', async () => {
    const { get } = await setup({
      rows: [
        eventRequestRow({
          id: '2',
          status: 'failed',
          failure: 'Meetup did not create the event.',
        }),
        eventRequestRow({
          id: '3',
          status: 'publishing',
          updatedAt: new Date(PAGE_NOW.getTime() - 11 * 60_000),
        }),
        eventRequestRow({ id: '4', status: 'publishing', updatedAt: PAGE_NOW }),
      ],
    });
    const res = await get(QUEUE);
    expect(res.text).toContain('Needs attention (3)');
    expect(res.text).toContain(`action="${QUEUE}/2/retry"`);
    expect(res.text).toContain(`action="${QUEUE}/3/retry"`);
    expect(res.text).not.toContain(`action="${QUEUE}/4/retry"`);
  });

  it('a store outage is a 503', async () => {
    const { get } = await setup();
    const res = await get(QUEUE);
    expect(res.status).toBe(200);
    const down = await setup({ rows: [] });
    vi.mocked(down.store.listByStatus).mockRejectedValue(new Error('pg down'));
    expect((await down.get(QUEUE)).status).toBe(503);
  });
});

describe('queue actions', () => {
  it('approve publishes as the leader, from pending, and logs it', async () => {
    const { post, publishRequest, audit } = await setup();
    const res = await post(`${QUEUE}/1/approve`, { version: '1' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${QUEUE}?result=published`);
    expect(publishRequest).toHaveBeenCalledWith('1', 1, USER.id, ['pending']);
    const entry = JSON.stringify(audit.mock.calls.at(-1)?.[0]);
    expect(entry).toContain('Host request approved');
    expect(entry).not.toMatch(/<@&|@everyone|@here/);
  });

  it('a second approval of the same version is a 409', async () => {
    const outcomes: PublishOutcome[] = [
      { code: 'published', request: eventRequestRow({ status: 'published' }) },
      { code: 'stale' },
    ];
    const { post, publishRequest } = await setup({
      publish: async () => Promise.resolve(outcomes.shift()),
    });
    expect((await post(`${QUEUE}/1/approve`, { version: '1' })).status).toBe(
      303,
    );
    const again = await post(`${QUEUE}/1/approve`, { version: '1' });
    expect(again.status).toBe(409);
    expect(again.text).toContain('Someone just acted on this request');
    expect(publishRequest).toHaveBeenCalledTimes(2);
  });

  it('retry publishes from failed or stuck', async () => {
    const { post, publishRequest } = await setup({
      rows: [eventRequestRow({ status: 'failed', version: 4 })],
    });
    await post(`${QUEUE}/1/retry`, { version: '4' });
    expect(publishRequest).toHaveBeenCalledWith('1', 4, USER.id, [
      'failed',
      'publishing',
    ]);
  });

  it('a failed publish says so', async () => {
    const { post } = await setup({
      publish: async () =>
        Promise.resolve({
          code: 'failed',
          request: eventRequestRow({ status: 'failed' }),
        }),
    });
    const res = await post(`${QUEUE}/1/approve`, { version: '1' });
    expect(res.headers.location).toBe(`${QUEUE}?result=failed`);
  });

  it('deny needs a reason, stores it and logs it', async () => {
    const { post, store, audit } = await setup();
    expect(
      (await post(`${QUEUE}/1/deny`, { version: '1' })).headers.location,
    ).toBe(`${QUEUE}?result=reason-required`);
    expect(
      (await post(`${QUEUE}/1/deny`, { version: '1', reason: 'x'.repeat(501) }))
        .headers.location,
    ).toBe(`${QUEUE}?result=reason-too-long`);
    const res = await post(`${QUEUE}/1/deny`, {
      version: '1',
      reason: '  Too close to the potluck  ',
    });
    expect(res.headers.location).toBe(`${QUEUE}?result=denied`);
    expect(store.deny).toHaveBeenLastCalledWith(
      '1',
      1,
      USER.id,
      'Too close to the potluck',
    );
    expect(JSON.stringify(audit.mock.calls.at(-1)?.[0])).toContain(
      'Host request denied',
    );
    // Already denied: the same version is stale.
    expect(
      (await post(`${QUEUE}/1/deny`, { version: '1', reason: 'again' })).status,
    ).toBe(409);
  });

  it('counts a line break in a reason once, as the textarea does', async () => {
    const { post, store } = await setup();
    const reason = `${'x'.repeat(248)}\r\n${'y'.repeat(250)}`;
    const res = await post(`${QUEUE}/1/deny`, { version: '1', reason });
    expect(res.headers.location).toBe(`${QUEUE}?result=denied`);
    expect(store.deny).toHaveBeenLastCalledWith(
      '1',
      1,
      USER.id,
      `${'x'.repeat(248)}\n${'y'.repeat(250)}`,
    );
  });

  it('a Moderator is refused and nothing changes', async () => {
    const { post, publishRequest, store, audit } = await setup({
      leader: false,
    });
    const res = await post(`${QUEUE}/1/approve`, { version: '1' });
    expect(res.headers.location).toBe(`${QUEUE}?result=not-leadership`);
    await post(`${QUEUE}/1/deny`, { version: '1', reason: 'no' });
    expect(publishRequest).not.toHaveBeenCalled();
    expect(store.deny).not.toHaveBeenCalled();
    // One refusal post per window.
    expect(
      audit.mock.calls.filter(([e]) =>
        JSON.stringify(e).includes('Host request action refused'),
      ),
    ).toHaveLength(1);
  });

  it('Discord being unreachable refuses without changing anything', async () => {
    const { post, publishRequest } = await setup({
      leader: new Error('discord down'),
    });
    const res = await post(`${QUEUE}/1/approve`, { version: '1' });
    expect(res.headers.location).toBe(`${QUEUE}?result=leadership-unavailable`);
    expect(publishRequest).not.toHaveBeenCalled();
  });

  it('a bad version, id or action is refused', async () => {
    const { post, publishRequest } = await setup();
    expect(
      (await post(`${QUEUE}/1/approve`, { version: 'x' })).headers.location,
    ).toBe(`${QUEUE}?result=invalid`);
    expect((await post(`${QUEUE}/abc/approve`, { version: '1' })).status).toBe(
      404,
    );
    expect((await post(`${QUEUE}/1/publish`, { version: '1' })).status).toBe(
      404,
    );
    expect(publishRequest).not.toHaveBeenCalled();
  });

  it('a result code shows fixed text; anything else shows nothing', async () => {
    const { get } = await setup();
    expect((await get(`${QUEUE}?result=denied`)).text).toContain(
      HOST_REQUEST_RESULT_MESSAGES.denied,
    );
    const odd = await get(`${QUEUE}?result=${encodeURIComponent(HOSTILE)}`);
    expect(odd.text).not.toContain('<script>alert');
  });
});

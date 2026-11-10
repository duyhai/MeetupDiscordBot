import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ExistingEvent,
  PUBLISH_FAILURES,
  PublishOutcome,
} from '../../../src/lib/hosts/publishRequest.js';
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
  GUEST_HOST_EVENT_DESCRIPTION,
  createEventTemplate,
} from '../../../src/templates/createEventTemplate.js';
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
const BOUNDED: unknown = expect.objectContaining({
  lockTimeoutMs: expect.any(Number) as unknown,
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
    rows?: EventRequest[];
    publish?: (
      id: string,
      version: number,
      actor: string,
    ) => Promise<PublishOutcome>;
    existing?: ExistingEvent | Error | 'never';
    /** How far the page clock jumps once Meetup has answered the check. */
    clockJumpAfterCheckMs?: number;
  } = {},
) {
  let clock = PAGE_NOW.getTime();
  const now = () => new Date(clock);
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
  const findExistingEvent = vi.fn(
    async (_request: EventRequest): Promise<ExistingEvent | undefined> => {
      if (options.existing instanceof Error) {
        throw options.existing;
      }
      if (options.existing === 'never') {
        // Meetup never answers.
        return new Promise<undefined>(() => undefined);
      }
      clock += options.clockJumpAfterCheckMs ?? 0;
      return options.existing;
    },
  );
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
          findExistingEvent,
          denyCheckDeadlineMs: 30,
          now,
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
  return {
    store,
    isLeadership,
    publishRequest,
    findExistingEvent,
    audit,
    get,
    post,
  };
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

  it('a failed request with no event can be denied; one with an event cannot', async () => {
    const { get } = await setup({
      rows: [
        eventRequestRow({
          id: '2',
          status: 'failed',
          failure: PUBLISH_FAILURES.notAHost,
        }),
        eventRequestRow({
          id: '3',
          status: 'failed',
          failure: 'RSVPs not applied.',
          meetupEventId: '317000001',
          eventUrl: 'https://www.meetup.com/1-5genasians/events/317000001/',
        }),
      ],
    });
    const res = await get(QUEUE);
    expect(res.text).toContain(`action="${QUEUE}/2/deny"`);
    expect(res.text).toContain(`action="${QUEUE}/2/retry"`);
    expect(res.text).not.toContain(`action="${QUEUE}/3/deny"`);
    expect(res.text).toContain(`action="${QUEUE}/3/retry"`);
  });

  it('a failed request with its event recorded offers Mark resolved, not Deny', async () => {
    const { get } = await setup({
      rows: [
        eventRequestRow({
          id: '2',
          status: 'failed',
          failure: PUBLISH_FAILURES.rsvp('https://www.meetup.com/x/events/1/'),
          meetupEventId: '317000001',
        }),
        eventRequestRow({ id: '3', status: 'failed', failure: 'No host.' }),
      ],
    });
    const res = await get(QUEUE);
    expect(res.text).toContain(`action="${QUEUE}/2/resolve"`);
    expect(res.text).not.toContain(`action="${QUEUE}/2/deny"`);
    expect(res.text).not.toContain(`action="${QUEUE}/3/resolve"`);
  });

  it('a failed request past its start with no event offers Deny, not Retry', async () => {
    const { get } = await setup({
      rows: [
        eventRequestRow({
          id: '2',
          status: 'failed',
          startLocal: '2026-10-05T09:00',
          failure: PUBLISH_FAILURES.startPassed,
        }),
        // Stuck: Retry is how it leaves 'publishing', even past its start.
        eventRequestRow({
          id: '3',
          status: 'publishing',
          startLocal: '2026-10-05T09:00',
          updatedAt: new Date(PAGE_NOW.getTime() - 11 * 60_000),
        }),
      ],
    });
    const res = await get(QUEUE);
    expect(res.text).not.toContain(`action="${QUEUE}/2/retry"`);
    expect(res.text).toContain(`action="${QUEUE}/2/deny"`);
    expect(res.text).toContain('so Retry can');
    expect(res.text).toContain(`action="${QUEUE}/3/retry"`);
  });

  it('a waiting request whose start has passed offers only Deny', async () => {
    const { get } = await setup({
      rows: [eventRequestRow({ startLocal: '2026-10-05T09:00' })],
    });
    const res = await get(QUEUE);
    expect(res.text).not.toContain(`action="${QUEUE}/1/approve"`);
    expect(res.text).toContain(`action="${QUEUE}/1/deny"`);
    expect(res.text).toContain('The start time has passed');
  });

  it('a card shows the limits and description it would publish, marking changes', async () => {
    const { get } = await setup({
      rows: [
        eventRequestRow({
          id: '1',
          description: `Bring snacks.\n${HOSTILE}`,
          rsvpLimit: 500,
          guestLimit: 1,
        }),
        eventRequestRow({
          id: '2',
          description: `💡 Host Tip: Start small 💡\n\n${GUEST_HOST_EVENT_DESCRIPTION}`,
        }),
      ],
    });
    const res = await get(QUEUE);
    expect(res.text).toContain('<strong>RSVP limit 500</strong> (default 12)');
    expect(res.text).toContain('Custom description');
    expect(res.text).toContain('Custom limits');
    expect(res.text).toContain('Description: written by the host');
    expect(res.text).toContain('Bring snacks.');
    expect(res.text).not.toContain('<script>alert');
    // The second: the standard description with a tip, default limits.
    expect(res.text).toContain('Description: the standard one');
    expect(res.text.match(/Custom description/g)).toHaveLength(1);
  });

  it('a copy’s card shows the venue, directions, photo and copied description', async () => {
    const { get } = await setup({
      rows: [
        eventRequestRow({
          id: '1',
          kind: 'copy',
          sourceEventId: '311111111',
          description: 'Meet at the trailhead.',
          venueId: '27000001',
          howToFindUs: HOSTILE,
          featuredPhotoId: 520000001,
        }),
        eventRequestRow({
          id: '2',
          kind: 'copy',
          sourceEventId: '311111112',
          venueId: null,
          howToFindUs: null,
          featuredPhotoId: null,
        }),
      ],
    });
    const res = await get(QUEUE);
    expect(res.text).toContain('Meetup venue 27000001');
    expect(res.text).toContain('Meetup photo 520000001');
    expect(res.text).toContain('none (online, or none set)');
    expect(res.text).toContain('Photo: none');
    expect(res.text).toContain("Description from the host's event");
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).not.toContain('<img src=x>');
  });

  it('a copy with the group’s photo says so, not a bare photo id', async () => {
    const { get } = await setup({
      rows: [
        eventRequestRow({
          kind: 'copy',
          sourceEventId: '311111111',
          featuredPhotoId: createEventTemplate.featuredPhotoId ?? null,
        }),
      ],
    });
    const res = await get(QUEUE);
    expect(res.text).toContain('Photo: the group&#39;s standard photo');
    expect(res.text).not.toContain('Meetup photo');
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
      BOUNDED,
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
      BOUNDED,
    );
  });

  it('deny of a failed request whose event is on Meetup is refused', async () => {
    const { post, store, findExistingEvent } = await setup({
      rows: [
        eventRequestRow({
          status: 'failed',
          version: 3,
          failure: PUBLISH_FAILURES.createFailed,
        }),
      ],
      existing: {
        id: '317000001',
        eventUrl: 'https://www.meetup.com/x/events/317000001/',
      },
    });
    const res = await post(`${QUEUE}/1/deny`, { version: '3', reason: 'No' });
    expect(res.headers.location).toBe(`${QUEUE}?result=deny-event-exists`);
    expect(findExistingEvent).toHaveBeenCalledOnce();
    expect(store.deny).not.toHaveBeenCalled();
  });

  it('deny of a failed request is refused when Meetup cannot be asked', async () => {
    const { post, store } = await setup({
      rows: [
        eventRequestRow({
          status: 'failed',
          version: 3,
          failure: PUBLISH_FAILURES.createFailed,
        }),
      ],
      existing: new Error('meetup down'),
    });
    const res = await post(`${QUEUE}/1/deny`, { version: '3', reason: 'No' });
    expect(res.headers.location).toBe(`${QUEUE}?result=deny-check-failed`);
    expect(store.deny).not.toHaveBeenCalled();
  });

  it('deny of a failed request is refused when Meetup answers too slowly, and never commits', async () => {
    const { post, store } = await setup({
      rows: [
        eventRequestRow({
          status: 'failed',
          version: 3,
          failure: PUBLISH_FAILURES.createFailed,
        }),
      ],
      existing: 'never',
    });
    const res = await post(`${QUEUE}/1/deny`, { version: '3', reason: 'No' });
    expect(res.headers.location).toBe(`${QUEUE}?result=deny-check-failed`);
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(store.deny).not.toHaveBeenCalled();
  });

  it('deny of a failed request with nothing on Meetup goes through', async () => {
    const { post, store } = await setup({
      rows: [
        eventRequestRow({
          status: 'failed',
          version: 3,
          failure: PUBLISH_FAILURES.createFailed,
        }),
      ],
    });
    const res = await post(`${QUEUE}/1/deny`, {
      version: '3',
      reason: 'Pick a new date',
    });
    expect(res.headers.location).toBe(`${QUEUE}?result=denied`);
    expect(store.deny).toHaveBeenCalledWith(
      '1',
      3,
      USER.id,
      'Pick a new date',
      BOUNDED,
    );
  });

  it('a deny whose Meetup check used up the page’s time is never written', async () => {
    const { post, store, audit } = await setup({
      rows: [
        eventRequestRow({
          status: 'failed',
          version: 3,
          failure: PUBLISH_FAILURES.createFailed,
        }),
      ],
      clockJumpAfterCheckMs: 21_000,
    });
    const res = await post(`${QUEUE}/1/deny`, { version: '3', reason: 'No' });
    expect(res.headers.location).toBe(`${QUEUE}?result=error`);
    expect(store.deny).not.toHaveBeenCalled();
    expect(JSON.stringify(audit.mock.calls)).not.toContain('denied');
  });

  it('the deny write gets only the page’s remaining time as its lock timeout', async () => {
    const { post, store } = await setup({
      rows: [
        eventRequestRow({
          status: 'failed',
          version: 3,
          failure: PUBLISH_FAILURES.createFailed,
        }),
      ],
      clockJumpAfterCheckMs: 15_000,
    });
    await post(`${QUEUE}/1/deny`, { version: '3', reason: 'No' });
    const options = store.deny.mock.calls[0]?.[4];
    // 20 s page deadline, 15 s gone: at most 5 s, and at least 1 ms.
    expect(options?.lockTimeoutMs).toBeGreaterThanOrEqual(1);
    expect(options?.lockTimeoutMs).toBeLessThanOrEqual(5_000);
  });

  it('a deny write that lands after the page gave up says so, and is logged when it lands', async () => {
    const { post, store, audit } = await setup({
      rows: [
        eventRequestRow({
          status: 'failed',
          version: 3,
          failure: PUBLISH_FAILURES.createFailed,
        }),
      ],
      // 10 ms of the page's 20 s left after the Meetup check.
      clockJumpAfterCheckMs: 19_990,
    });
    store.deny.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(eventRequestRow({ status: 'denied', version: 4 }));
          }, 80);
        }),
    );
    const res = await post(`${QUEUE}/1/deny`, { version: '3', reason: 'No' });
    expect(res.headers.location).toBe(`${QUEUE}?result=deny-slow`);
    await vi.waitFor(() => {
      expect(JSON.stringify(audit.mock.calls)).toContain(
        'saved after the page timed out',
      );
    });
  });

  it('deny of a waiting request does not ask Meetup', async () => {
    const { post, findExistingEvent } = await setup();
    await post(`${QUEUE}/1/deny`, { version: '1', reason: 'No' });
    expect(findExistingEvent).not.toHaveBeenCalled();
  });

  it('Mark resolved publishes a failed request with its event, and logs it', async () => {
    const { post, store, audit } = await setup({
      rows: [
        eventRequestRow({
          status: 'failed',
          version: 5,
          failure: 'RSVPs not applied.',
          meetupEventId: '317000001',
          title: '**bold** [Free](https://evil.example) @everyone',
        }),
      ],
    });
    const res = await post(`${QUEUE}/1/resolve`, { version: '5' });
    expect(res.headers.location).toBe(`${QUEUE}?result=resolved`);
    expect(store.resolve).toHaveBeenCalledWith('1', 5, USER.id);
    const entry = JSON.stringify(audit.mock.calls.at(-1)?.[0]);
    expect(entry).toContain('Host request marked resolved');
    expect(entry).toContain('\\\\[Free](https://evil.example)');
    expect(entry).toContain('\\\\*\\\\*bold');
    // Already resolved: the same version is stale.
    expect((await post(`${QUEUE}/1/resolve`, { version: '5' })).status).toBe(
      409,
    );
  });

  it('Mark resolved of a request with no event recorded changes nothing', async () => {
    const { post } = await setup({
      rows: [eventRequestRow({ status: 'failed', failure: 'No host.' })],
    });
    expect((await post(`${QUEUE}/1/resolve`, { version: '1' })).status).toBe(
      409,
    );
  });

  it('a Moderator is refused and nothing changes', async () => {
    const { post, publishRequest, store, audit } = await setup({
      leader: false,
    });
    const res = await post(`${QUEUE}/1/approve`, { version: '1' });
    expect(res.headers.location).toBe(`${QUEUE}?result=not-leadership`);
    await post(`${QUEUE}/1/deny`, { version: '1', reason: 'no' });
    await post(`${QUEUE}/1/resolve`, { version: '1' });
    expect(publishRequest).not.toHaveBeenCalled();
    expect(store.deny).not.toHaveBeenCalled();
    expect(store.resolve).not.toHaveBeenCalled();
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

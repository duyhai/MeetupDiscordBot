import { afterEach, describe, expect, it, vi } from 'vitest';

import { CopySource } from '../../../src/lib/hosts/eventRequest.js';
import { GUEST_HOST_EVENT_DESCRIPTION } from '../../../src/templates/createEventTemplate.js';
import {
  EventRequest,
  NewEventRequest,
} from '../../../src/lib/repositories/postgresEventRequestRepository.js';
import {
  CreatePageDeps,
  MAX_PENDING,
  registerCreatePages,
} from '../../../src/web/host/createPage.js';
import { LoopbackClient } from '../../setup/loopbackServer.js';
import {
  DISCORD_USER,
  HOST,
  ORIGIN,
  closeServers,
  makeHostApp,
  signInWithDiscord,
} from './hostHarness.js';

afterEach(closeServers);

// Tuesday 2026-11-03, 10:00 Pacific.
const NOW = new Date('2026-11-03T18:00:00Z');
const MEMBER = '4242';
const HOSTILE = '<script>alert(1)</script>"><img src=x>';

function memoryStore() {
  const rows: EventRequest[] = [];
  return {
    rows,
    store: {
      create: vi.fn(
        async (
          input: NewEventRequest,
          _options?: { maxPending?: number },
        ): Promise<EventRequest | undefined | 'full'> => {
          await Promise.resolve();
          // The unique (member, submit token) index: a repeat makes nothing.
          if (
            input.submitToken &&
            rows.some(
              (r) =>
                r.meetupMemberId === input.meetupMemberId &&
                r.submitToken === input.submitToken,
            )
          ) {
            return undefined;
          }
          const row: EventRequest = {
            ...input,
            id: String(rows.length + 1),
            source: input.source ?? 'web',
            discordPost: null,
            status: 'pending',
            denyReason: null,
            failure: null,
            decidedBy: null,
            decidedAt: null,
            meetupEventId: null,
            eventUrl: null,
            version: 1,
            createdAt: NOW,
            updatedAt: NOW,
          };
          rows.push(row);
          return row;
        },
      ),
      get: vi.fn(async (id: string) => {
        await Promise.resolve();
        return rows.find((r) => r.id === id);
      }),
      findBySubmitToken: vi.fn(async (member: string, token: string) => {
        await Promise.resolve();
        return rows.find(
          (r) => r.meetupMemberId === member && r.submitToken === token,
        );
      }),
      listForMember: vi.fn(async (member: string) => {
        await Promise.resolve();
        return rows.filter((r) => r.meetupMemberId === member).reverse();
      }),
      countPending: vi.fn(async (member: string) => {
        await Promise.resolve();
        return rows.filter(
          (r) => r.meetupMemberId === member && r.status === 'pending',
        ).length;
      }),
    },
  };
}

const source = (over: Partial<CopySource> = {}): CopySource => ({
  id: '311111111',
  eventUrl: 'https://www.meetup.com/1-5genasians/events/311111111/',
  group: { urlname: '1-5genasians' },
  title: `[Guest Host] ${HOSTILE}`,
  description: 'Meet at the trailhead.',
  dateTime: '2026-09-12T17:30:00-07:00',
  duration: 'PT3H',
  maxTickets: 15,
  guestLimit: 2,
  howToFindUs: 'Orange flag',
  featuredEventPhoto: { id: '520000001' },
  venue: { id: '27000001' },
  eventHosts: [{ member: { id: MEMBER } }],
  ...over,
});

async function app(
  over: Partial<CreatePageDeps> = {},
  tier: 'regular' | 'promoted' = 'regular',
) {
  const mem = memoryStore();
  const deps: CreatePageDeps = {
    now: () => NOW,
    requests: async () => Promise.resolve(mem.store),
    copySource: vi.fn(async (id: string) => {
      await Promise.resolve();
      return id === '311111111' ? source() : undefined;
    }),
    publish: vi.fn(async (id: string) => {
      await Promise.resolve();
      const row = mem.rows.find((r) => r.id === id);
      Object.assign(row, {
        status: 'published',
        eventUrl: 'https://www.meetup.com/1-5genasians/events/317000001/',
      });
      return { code: 'published' as const, request: row };
    }),
    alert: vi.fn().mockResolvedValue(true),
    tip: () => 'Start small',
    ...over,
  };
  const { req, cache } = await makeHostApp({
    resolve: vi.fn().mockResolvedValue({ ...HOST, tier }),
    pages: (router) => registerCreatePages(router, deps, ORIGIN),
  });
  const sid = await signInWithDiscord(req);
  const csrf = (
    JSON.parse(
      [...cache.values.entries()].find(([k]) =>
        k.startsWith('host-session-'),
      )?.[1] ?? '{}',
    ) as { csrfToken: string }
  ).csrfToken;
  let forms = 0;
  // Each call is a new form unless the body names its `submit` token.
  const post = (body: Record<string, string>, token = csrf) => {
    forms += 1;
    return req
      .post('/host/create')
      .set('Cookie', sid)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: token, submit: `form-token-${forms}-padding`, ...body });
  };
  return { req, sid, deps, mem, post };
}

const good = {
  title: 'Board game night',
  day: '2026-11-20',
  time: '19:00',
  duration: 'PT2H',
};

const get = (req: LoopbackClient, sid: string, path: string) =>
  req.get(path).set('Cookie', sid);

describe('host create form', () => {
  it('starts a fresh form on the picked day', async () => {
    const { req, sid } = await app();
    const res = await get(req, sid, '/host/create?day=2026-11-20');
    expect(res.status).toBe(200);
    expect(res.text).toContain('value="2026-11-20"');
    expect(res.text).toContain('Send for approval');
    expect(res.text).toContain('<option value="19:00" selected>');
    expect(res.text).not.toContain('style=');
  });

  it('offers copying a past event from My history, on the fresh form only', async () => {
    const { req, sid } = await app();
    const fresh = await get(req, sid, '/host/create');
    expect(fresh.text).toContain('Copy one of your past events');
    expect(fresh.text).toMatch(
      /<a href="\/host\/history"\s*>open My history<\/a/,
    );
    const copy = await get(req, sid, '/host/create?copy=311111111');
    expect(copy.text).not.toContain('Copy one of your past events');
  });

  it('ignores a day that is past or not a date', async () => {
    const { req, sid } = await app();
    const pages = await Promise.all(
      ['2026-11-03', '2026-02-30', '"><x'].map((day) =>
        get(req, sid, `/host/create?day=${encodeURIComponent(day)}`),
      ),
    );
    for (const res of pages) {
      expect(res.status).toBe(200);
      expect(res.text).toMatch(
        /name="day"\s+min="2026-11-04"\s+max="2027-11-03"\s+value=""/,
      );
    }
  });

  it('a copy starts from the host’s own event, escaped', async () => {
    const { req, sid } = await app();
    const res = await get(req, sid, '/host/create?copy=311111111');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Copy an event');
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).not.toContain('<img src=x>');
    expect(res.text).toContain('<option value="17:30" selected>');
    expect(res.text).toContain('<option value="PT3H" selected>');
    expect(res.text).toContain('name="copy" value="311111111"');
  });

  it('copying someone else’s event, or an unknown one, is a 404', async () => {
    const { req, sid, deps } = await app({
      copySource: vi
        .fn()
        .mockResolvedValue(
          source({ eventHosts: [{ member: { id: '9999' } }] }),
        ),
    });
    expect((await get(req, sid, '/host/create?copy=311111111')).status).toBe(
      404,
    );
    expect((await get(req, sid, '/host/create?copy=1%3B2')).status).toBe(404);
    expect(deps.copySource).toHaveBeenCalledTimes(1);
  });

  it('an event from another group cannot be copied', async () => {
    const { req, sid } = await app({
      copySource: vi
        .fn()
        .mockResolvedValue(source({ group: { urlname: 'another-group' } })),
    });
    expect((await get(req, sid, '/host/create?copy=311111111')).status).toBe(
      404,
    );
  });

  it('an older event id with letters can be copied', async () => {
    const { req, sid, deps } = await app({
      copySource: vi.fn().mockResolvedValue(source({ id: 'qxkdltyfccbbc' })),
    });
    expect(
      (await get(req, sid, '/host/create?copy=qxkdltyfccbbc')).status,
    ).toBe(200);
    expect(deps.copySource).toHaveBeenCalledWith('qxkdltyfccbbc');
  });

  it('a Meetup outage on copy is a 503', async () => {
    const { req, sid } = await app({
      copySource: vi.fn().mockRejectedValue(new Error('down')),
    });
    expect((await get(req, sid, '/host/create?copy=311111111')).status).toBe(
      503,
    );
  });
});

describe('submitting a request', () => {
  it('a regular host’s request waits for approval and alerts leadership plainly', async () => {
    const { post, mem, deps, req, sid } = await app();
    const res = await post(good);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/host/requests/1');
    expect(mem.rows[0]).toMatchObject({
      meetupMemberId: MEMBER,
      discordUserId: DISCORD_USER.id,
      tier: 'regular',
      kind: 'fresh',
      title: 'Board game night',
      startLocal: '2026-11-20T19:00',
      duration: 'PT2H',
      status: 'pending',
    });
    expect(mem.rows[0].description).toMatch(/^💡 Host Tip: Start small/);
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.alert).toHaveBeenCalledTimes(1);
    const alert = JSON.stringify(vi.mocked(deps.alert).mock.calls[0][0]);
    expect(alert).toContain(`${ORIGIN}/dashboard/hosts/requests`);
    expect(alert).not.toMatch(/<@|@everyone|@here/);
    const page = await get(req, sid, '/host/requests/1');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Waiting for approval');
  });

  it('a regular host’s request is posted to Discord; a Community Host’s is not', async () => {
    const postToDiscord = vi.fn().mockResolvedValue(undefined);
    const regular = await app({ postToDiscord });
    await regular.post(good);
    expect(postToDiscord).toHaveBeenCalledTimes(1);
    expect(postToDiscord.mock.calls[0][0]).toMatchObject({
      id: '1',
      title: 'Board game night',
      source: 'web',
    });
    const promoted = await app({ postToDiscord: vi.fn() }, 'promoted');
    await promoted.post(good);
    expect(promoted.deps.postToDiscord).not.toHaveBeenCalled();
  });

  it('a Discord post that fails leaves the request page unaffected', async () => {
    const postToDiscord = vi.fn().mockRejectedValue(new Error('no channel'));
    const { post } = await app({ postToDiscord });
    const res = await post(good);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/host/requests/1');
  });

  it('a Community Host’s request is published at once', async () => {
    const { post, mem, deps } = await app({}, 'promoted');
    const res = await post(good);
    expect(res.status).toBe(303);
    expect(deps.publish).toHaveBeenCalledWith('1', 1, MEMBER);
    expect(mem.rows[0].description).not.toContain('Host Tip');
    expect(JSON.stringify(vi.mocked(deps.alert).mock.calls[0][0])).toContain(
      'Community Host published',
    );
  });

  it('a copy keeps the source’s settings and re-checks ownership on submit', async () => {
    const { post, mem } = await app();
    await post({ ...good, copy: '311111111' });
    expect(mem.rows[0]).toMatchObject({
      kind: 'copy',
      sourceEventId: '311111111',
      description: 'Meet at the trailhead.',
      rsvpLimit: 15,
      guestLimit: 2,
      venueId: '27000001',
      howToFindUs: 'Orange flag',
      featuredPhotoId: 520000001,
    });
    const other = await app({
      copySource: vi
        .fn()
        .mockResolvedValue(
          source({ eventHosts: [{ member: { id: '9999' } }] }),
        ),
    });
    expect((await other.post({ ...good, copy: '311111111' })).status).toBe(404);
    expect(other.mem.rows).toHaveLength(0);
  });

  it('errors re-render the form with the host’s input escaped', async () => {
    const { post, mem } = await app();
    const res = await post({
      ...good,
      title: `${HOSTILE}\nx`,
      day: '2026-11-03',
    });
    expect(res.status).toBe(422);
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).toContain('&lt;script&gt;');
    expect(res.text).toContain('The title must be one line');
    expect(res.text).toContain('Pick a date from tomorrow on.');
    expect(mem.rows).toHaveLength(0);
  });

  it('a POST without the CSRF token is refused', async () => {
    const { post, mem } = await app();
    expect((await post(good, 'wrong')).status).toBe(403);
    expect(mem.rows).toHaveLength(0);
  });

  it(`refuses more than ${MAX_PENDING} waiting requests`, async () => {
    const { post, mem } = await app();
    for (let i = 0; i < MAX_PENDING; i += 1) {
      // One at a time: each submit reads the count the last one left.
      // eslint-disable-next-line no-await-in-loop
      expect((await post(good)).status).toBe(303);
    }
    const res = await post(good);
    expect(res.status).toBe(429);
    expect(res.text).toContain('waiting for approval');
    expect(mem.rows).toHaveLength(MAX_PENDING);
  });

  it('a submit that loses the race to the cap (the store says full) is refused the same way', async () => {
    const { post, mem } = await app();
    const { create } = mem.store;
    create.mockResolvedValueOnce('full');
    const res = await post(good);
    expect(res.status).toBe(429);
    expect(res.text).toContain('waiting for approval');
    expect(create).toHaveBeenCalledWith(expect.anything(), {
      maxPending: MAX_PENDING,
    });
    expect(mem.rows).toHaveLength(0);
  });

  it('the form carries a one-time token, new on every render', async () => {
    const { req, sid } = await app();
    const tokenOf = (text: string) =>
      /name="submit" value="([A-Za-z0-9_-]{16,64})"/.exec(text)?.[1];
    const a = tokenOf((await get(req, sid, '/host/create')).text);
    const b = tokenOf((await get(req, sid, '/host/create')).text);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('a Community Host’s form sent twice publishes once', async () => {
    const { post, mem, deps } = await app({}, 'promoted');
    const once = { ...good, submit: 'same-form-token-123' };
    const first = await post(once);
    const second = await post(once);
    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(second.headers.location).toBe(first.headers.location);
    expect(mem.rows).toHaveLength(1);
    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(deps.alert).toHaveBeenCalledTimes(1);
  });

  it('a form sent twice at the cap goes to its request, not a refusal', async () => {
    const { post, mem, deps } = await app();
    for (let i = 0; i < MAX_PENDING - 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await post(good)).status).toBe(303);
    }
    const once = { ...good, submit: 'last-form-token-123' };
    expect((await post(once)).status).toBe(303);
    const again = await post(once);
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe(`/host/requests/${MAX_PENDING}`);
    expect(mem.rows).toHaveLength(MAX_PENDING);
    expect(deps.alert).toHaveBeenCalledTimes(MAX_PENDING);
  });

  it('two sends of one form at the same moment make one request', async () => {
    const { post, mem, deps } = await app({}, 'promoted');
    const once = { ...good, submit: 'raced-form-token-12' };
    expect((await post(once)).status).toBe(303);
    // The second send looked before the first one's row existed.
    mem.store.findBySubmitToken.mockResolvedValueOnce(undefined);
    const raced = await post(once);
    expect(raced.status).toBe(303);
    expect(raced.headers.location).toBe('/host/requests/1');
    expect(mem.rows).toHaveLength(1);
    expect(deps.publish).toHaveBeenCalledTimes(1);
  });

  it('a form without its token is re-shown, and nothing is made', async () => {
    const { post, mem } = await app();
    const res = await post({ ...good, submit: 'short' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('This form was out of date');
    expect(res.text).toMatch(/name="submit" value="[A-Za-z0-9_-]{16,64}"/);
    expect(mem.rows).toHaveLength(0);
  });

  it('a copy ignores any description or limits sent with it', async () => {
    const { post, mem } = await app();
    const res = await post({
      ...good,
      copy: '311111111',
      description: 'Forged',
      rsvpLimit: '9000',
      guestLimit: 'x',
    });
    expect(res.status).toBe(303);
    expect(mem.rows[0]).toMatchObject({
      kind: 'copy',
      description: 'Meet at the trailhead.',
      rsvpLimit: 15,
      guestLimit: 2,
    });
  });

  it('a fresh form folds the optional fields away, pre-filled; a copy has none', async () => {
    const { req, sid } = await app();
    const fresh = await get(req, sid, '/host/create');
    expect(fresh.text).toContain('<details class="more-options">');
    expect(fresh.text).toContain('<summary>More options</summary>');
    expect(fresh.text).toContain('**EVENT DETAILS**');
    expect(fresh.text).toMatch(/name="rsvpLimit"[^>]*value=""/);
    const copy = await get(req, sid, '/host/create?copy=311111111');
    expect(copy.text).not.toContain('<details class="more-options"');
  });

  it('stores the host’s description and limits, tip first, and publishes them', async () => {
    const { post, mem } = await app();
    const res = await post({
      ...good,
      description: 'Bring a game.\r\nWe meet at the cafe.',
      rsvpLimit: '30',
      guestLimit: '0',
    });
    expect(res.status).toBe(303);
    expect(mem.rows[0]).toMatchObject({
      description:
        '💡 Host Tip: Start small 💡\n\nBring a game.\nWe meet at the cafe.',
      rsvpLimit: 30,
      guestLimit: 0,
    });
  });

  it('untouched optional fields mean the template', async () => {
    const { post, mem } = await app({}, 'promoted');
    await post({
      ...good,
      description: GUEST_HOST_EVENT_DESCRIPTION.replace(/\n/g, '\r\n'),
      rsvpLimit: '',
      guestLimit: '',
    });
    expect(mem.rows[0]).toMatchObject({
      description: GUEST_HOST_EVENT_DESCRIPTION,
      rsvpLimit: 12,
      guestLimit: 1,
    });
  });

  it('a bad limit re-opens the options with the host’s text escaped', async () => {
    const { post, mem } = await app();
    const res = await post({
      ...good,
      description: HOSTILE,
      rsvpLimit: '9000',
    });
    expect(res.status).toBe(422);
    expect(res.text).toContain('<details class="more-options" open>');
    expect(res.text).toContain('Enter an RSVP limit from 1 to 500');
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mem.rows).toHaveLength(0);
  });

  it('a form sent again with changes says the changes were not saved', async () => {
    const { req, sid, post, mem } = await app();
    const first = await post({ ...good, submit: 'same-form-token-0001' });
    const again = await post({
      ...good,
      title: 'Board game night, edited',
      submit: 'same-form-token-0001',
    });
    expect(mem.rows).toHaveLength(1);
    expect(again.headers.location).toBe('/host/requests/1?resent=changed');
    const page = await get(req, sid, again.headers.location);
    expect(page.text).toContain('changes in your second send');
    expect(page.text).toContain('Board game night');
    // A plain repeat goes to the request with no notice.
    const repeat = await post({ ...good, submit: 'same-form-token-0001' });
    expect(repeat.headers.location).toBe(first.headers.location);
  });

  it('a Community Host publish that outlasts the page still alerts when it finishes', async () => {
    let finish: (() => void) | undefined;
    const { post, deps, mem } = await app(
      {
        publishDeadlineMs: 20,
        publish: vi.fn(async (id: string) => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          const row = mem.rows.find((r) => r.id === id);
          Object.assign(row, {
            status: 'published',
            eventUrl: 'https://www.meetup.com/1-5genasians/events/317000001/',
          });
          return { code: 'published' as const, request: row };
        }),
      },
      'promoted',
    );
    const res = await post({ ...good, title: '**Bold** _night_' });
    expect(res.status).toBe(303);
    expect(deps.alert).not.toHaveBeenCalled();
    finish?.();
    await vi.waitFor(() => expect(deps.alert).toHaveBeenCalledOnce());
    const entry = JSON.stringify(vi.mocked(deps.alert).mock.calls[0]?.[0]);
    expect(entry).toContain('Community Host published an event');
    expect(entry).toContain('\\\\*\\\\*Bold');
  });

  it('a database outage is a 503 and nothing is alerted', async () => {
    const { post, deps } = await app({
      requests: vi.fn().mockRejectedValue(new Error('pg down')),
    });
    expect((await post(good)).status).toBe(503);
    expect(deps.alert).not.toHaveBeenCalled();
  });
});

describe('request page', () => {
  it('shows only the host’s own requests', async () => {
    const { req, sid, mem } = await app();
    mem.rows.push({
      ...((await mem.store.create({
        meetupMemberId: '9999',
        discordUserId: null,
        hostName: 'Other',
        tier: 'regular',
        kind: 'fresh',
        sourceEventId: null,
        title: 'Not yours',
        description: '',
        startLocal: '2026-11-20T19:00',
        duration: 'PT2H',
        rsvpLimit: 12,
        guestLimit: 1,
        featuredPhotoId: null,
        venueId: null,
        howToFindUs: null,
      })) as EventRequest),
    });
    expect((await get(req, sid, '/host/requests/1')).status).toBe(404);
    expect((await get(req, sid, '/host/requests/abc')).status).toBe(404);
    expect((await get(req, sid, '/host/requests/999')).status).toBe(404);
  });

  it('a denied request shows the reason, escaped', async () => {
    const { req, sid, post, mem } = await app();
    await post(good);
    Object.assign(mem.rows[0], { status: 'denied', denyReason: HOSTILE });
    const res = await get(req, sid, '/host/requests/1');
    expect(res.text).toContain('Not approved');
    expect(res.text).not.toContain('<script>alert');
  });
});

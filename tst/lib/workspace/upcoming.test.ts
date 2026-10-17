import { ClientError } from 'graphql-request';
import { Logger } from 'tslog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KeyValueCache } from '../../../src/lib/cache/base.js';
import type { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import type { EventSummary } from '../../../src/lib/client/meetup/types.js';
import {
  type OrganizerMeetupDeps,
  OrganizerTokenUnavailableError,
} from '../../../src/lib/reports/organizerMeetup.js';
import {
  UPCOMING_BATCH_TIMEOUT_MS,
  UPCOMING_CACHE_TTL_SEC,
  UPCOMING_DEADLINE_MS,
  UPCOMING_MAX_MEMBERS,
  UPCOMING_UNAVAILABLE_TTL_SEC,
  actByFor,
  createUpcomingLoader,
  organizerFetchMany,
  type UpcomingDeps,
  type UpcomingEntry,
} from '../../../src/lib/workspace/upcoming.js';
import { FakeCache } from '../../web/fakeCache.js';

const NOW = new Date('2026-10-17T18:00:00Z');

const event = (
  id: string,
  dateTime: string,
  extra: Partial<EventSummary> = {},
): EventSummary => ({
  id,
  title: `Event ${id}`,
  eventUrl: `https://www.meetup.com/g/events/${id}/`,
  dateTime,
  ...extra,
});

interface Harness {
  cache: FakeCache;
  fetchMany: ReturnType<typeof vi.fn>;
  deps: UpcomingDeps;
}

function harness(
  fetchMany: (
    ids: string[],
  ) => Promise<Map<string, EventSummary[] | undefined>>,
  cache: KeyValueCache = new FakeCache(),
): Harness {
  const fn = vi.fn(fetchMany);
  return {
    cache: cache as FakeCache,
    fetchMany: fn,
    deps: { now: () => NOW, cache: async () => cache, fetchMany: fn },
  };
}

interface StoredShape {
  state: string;
  fetchedAt: string;
  events: Record<string, unknown>[];
}

const okMap = (entries: [string, EventSummary[] | undefined][]) => async () =>
  new Map(entries);

describe('createUpcomingLoader', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves cached members without calling Meetup', async () => {
    const h = harness(okMap([]));
    await h.cache.set(
      'workspace-upcoming-v1-111',
      JSON.stringify({ state: 'left', fetchedAt: NOW.toISOString() }),
    );
    const out = await createUpcomingLoader(h.deps)(['111']);
    expect(out.get('111')).toEqual({
      state: 'left',
      fetchedAt: NOW.toISOString(),
    });
    expect(h.fetchMany).not.toHaveBeenCalled();
  });

  it('fetches misses in one batch and caches derived fields for 6 hours', async () => {
    const h = harness(
      okMap([
        ['111', [event('e1', '2026-10-25T02:00:00Z')]],
        ['222', [event('e2', '2026-10-26T02:00:00Z')]],
      ]),
    );
    const out = await createUpcomingLoader(h.deps)(['111', '222']);
    expect(h.fetchMany).toHaveBeenCalledTimes(1);
    expect(h.fetchMany).toHaveBeenCalledWith(['111', '222']);
    expect(out.get('111')?.state).toBe('ok');
    const key = 'workspace-upcoming-v1-111';
    const ttl = h.cache.ttls.get(key);
    expect(ttl).toBe(UPCOMING_CACHE_TTL_SEC);
    expect(ttl).toBe(21600);
    expect(ttl).toBeLessThanOrEqual(12 * 3600);
    const stored = JSON.parse(h.cache.values.get(key) ?? '') as StoredShape;
    expect(Object.keys(stored).sort()).toEqual([
      'events',
      'fetchedAt',
      'state',
    ]);
    expect(Object.keys(stored.events[0]).sort()).toEqual([
      'dateTime',
      'eventUrl',
      'id',
      'payment',
      'title',
    ]);
  });

  it('raw descriptions never reach the cache', async () => {
    const h = harness(
      okMap([
        [
          '111',
          [
            event('e1', '2026-10-25T02:00:00Z', {
              description: 'Venmo me SECRET-BODY',
              feeSettings: null,
            }),
          ],
        ],
      ]),
    );
    const out = await createUpcomingLoader(h.deps)(['111']);
    const text = h.cache.values.get('workspace-upcoming-v1-111');
    expect(text).not.toContain('SECRET-BODY');
    expect(text).not.toContain('"description"');
    expect(text).not.toContain('"feeSettings"');
    expect(
      Object.keys((JSON.parse(text) as StoredShape).events[0]),
    ).not.toContain('description');
    const entry = out.get('111') as { events: { payment: string | null }[] };
    expect(entry.events[0].payment).toBe('description mentions payment');
    expect(JSON.stringify([...out.values()])).not.toContain('SECRET-BODY');
  });

  it('marks a Meetup fee', async () => {
    const h = harness(
      okMap([
        [
          '111',
          [
            event('e1', '2026-10-25T02:00:00Z', {
              feeSettings: { amount: 15, currency: 'USD' },
            }),
          ],
        ],
      ]),
    );
    const out = await createUpcomingLoader(h.deps)(['111']);
    const entry = out.get('111') as { events: { payment: string | null }[] };
    expect(entry.events[0].payment).toBe('$15 event fee');
  });

  it('has a null payment when nothing mentions money', async () => {
    const h = harness(okMap([['111', [event('e1', '2026-10-25T02:00:00Z')]]]));
    const out = await createUpcomingLoader(h.deps)(['111']);
    const entry = out.get('111') as { events: { payment: string | null }[] };
    expect(entry.events[0].payment).toBeNull();
  });

  it('drops past events and sorts earliest first', async () => {
    const h = harness(
      okMap([
        [
          '111',
          [
            event('late', '2026-11-05T02:00:00Z'),
            event('past', '2026-10-01T02:00:00Z'),
            event('soon', '2026-10-20T02:00:00Z'),
          ],
        ],
      ]),
    );
    const out = await createUpcomingLoader(h.deps)(['111']);
    const entry = out.get('111') as { events: { id: string }[] };
    expect(entry.events.map((e) => e.id)).toEqual(['soon', 'late']);
  });

  it('a member who left the group is cached as left', async () => {
    const h = harness(okMap([['111', undefined]]));
    const out = await createUpcomingLoader(h.deps)(['111']);
    expect(out.get('111')).toEqual({
      state: 'left',
      fetchedAt: NOW.toISOString(),
    });
    expect(
      (
        JSON.parse(
          h.cache.values.get('workspace-upcoming-v1-111') ?? '',
        ) as StoredShape
      ).state,
    ).toBe('left');
  });

  it('members still loading at the deadline are pending and cached when they finish', async () => {
    vi.useFakeTimers();
    let release!: (m: Map<string, EventSummary[] | undefined>) => void;
    const h = harness(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const load = createUpcomingLoader(h.deps)(['111']);
    await vi.advanceTimersByTimeAsync(UPCOMING_DEADLINE_MS - 1);
    let settled = false;
    void load.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = await load;
    expect(out.get('111')).toEqual({ state: 'pending' });
    expect(h.cache.values.has('workspace-upcoming-v1-111')).toBe(false);

    release(new Map([['111', [event('e1', '2026-10-25T02:00:00Z')]]]));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.cache.values.has('workspace-upcoming-v1-111')).toBe(true);
  });

  it('the deadline defaults to 6 seconds', () => {
    expect(UPCOMING_DEADLINE_MS).toBe(6000);
  });

  it('Meetup failure is unavailable, remembered for 60 s only', async () => {
    const h = harness(async () => {
      throw new Error('meetup down');
    });
    const out = await createUpcomingLoader(h.deps)(['111', '222']);
    expect(out.get('111')).toEqual({ state: 'unavailable' });
    expect(out.get('222')).toEqual({ state: 'unavailable' });
    expect(UPCOMING_UNAVAILABLE_TTL_SEC).toBe(60);
    for (const id of ['111', '222']) {
      const key = `workspace-upcoming-v1-${id}`;
      expect(h.cache.ttls.get(key)).toBe(UPCOMING_UNAVAILABLE_TTL_SEC);
      // Nothing from Meetup: the state and when, nothing else.
      expect(JSON.parse(h.cache.values.get(key) ?? '')).toEqual({
        state: 'unavailable',
        fetchedAt: NOW.toISOString(),
      });
    }
  });

  it('a reload within 60 s of a Meetup failure makes no Meetup call; after 60 s it asks again', async () => {
    let clock = NOW.getTime();
    let fail = true;
    const h = harness(async (ids) => {
      if (fail) {
        throw new Error('meetup down');
      }
      return new Map(ids.map((id) => [id, [] as EventSummary[]]));
    });
    h.deps.now = () => new Date(clock);
    const load = createUpcomingLoader(h.deps);
    expect((await load(['111'])).get('111')).toEqual({ state: 'unavailable' });
    expect(h.fetchMany).toHaveBeenCalledTimes(1);
    fail = false;
    clock += UPCOMING_UNAVAILABLE_TTL_SEC * 1000 - 1;
    expect((await load(['111'])).get('111')).toEqual({ state: 'unavailable' });
    expect(h.fetchMany).toHaveBeenCalledTimes(1);
    // The fake cache keeps keys forever; the loader checks the age itself.
    clock += 1;
    expect((await load(['111'])).get('111')?.state).toBe('ok');
    expect(h.fetchMany).toHaveBeenCalledTimes(2);
    expect(h.cache.ttls.get('workspace-upcoming-v1-111')).toBe(
      UPCOMING_CACHE_TTL_SEC,
    );
  });

  it('a remembered unavailable answer from the future is not trusted', async () => {
    const h = harness(okMap([['111', []]]));
    await h.cache.set(
      'workspace-upcoming-v1-111',
      JSON.stringify({
        state: 'unavailable',
        fetchedAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      }),
    );
    expect(
      (await createUpcomingLoader(h.deps)(['111'])).get('111')?.state,
    ).toBe('ok');
    expect(h.fetchMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no time', { state: 'unavailable' }],
    ['a junk time', { state: 'unavailable', fetchedAt: 'yesterday' }],
    ['a number', { state: 'unavailable', fetchedAt: 5 }],
  ])(
    'a remembered unavailable answer with %s is ignored',
    async (_what, stored) => {
      const h = harness(okMap([['111', []]]));
      await h.cache.set('workspace-upcoming-v1-111', JSON.stringify(stored));
      expect(
        (await createUpcomingLoader(h.deps)(['111'])).get('111')?.state,
      ).toBe('ok');
    },
  );

  it('a synchronous fetchMany throw is unavailable too', async () => {
    const h = harness(() => {
      throw new Error('boom');
    });
    const out = await createUpcomingLoader(h.deps)(['111']);
    expect(out.get('111')).toEqual({ state: 'unavailable' });
  });

  it('one fetch per member across concurrent page loads', async () => {
    let release!: (m: Map<string, EventSummary[] | undefined>) => void;
    const h = harness(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const load = createUpcomingLoader(h.deps);
    const a = load(['111']);
    const b = load(['111']);
    await new Promise((r) => {
      setImmediate(r);
    });
    release(new Map([['111', [event('e1', '2026-10-25T02:00:00Z')]]]));
    const [ra, rb] = await Promise.all([a, b]);
    expect(h.fetchMany).toHaveBeenCalledTimes(1);
    expect(h.fetchMany).toHaveBeenCalledWith(['111']);
    expect(ra.get('111')?.state).toBe('ok');
    expect(rb.get('111')?.state).toBe('ok');
  });

  it('a failed shared fetch is unavailable for every waiting load, and a load after 60 s retries', async () => {
    let fail = true;
    let clock = NOW.getTime();
    const h = harness(async () => {
      if (fail) {
        throw new Error('down');
      }
      return new Map([['111', [] as EventSummary[]]]);
    });
    h.deps.now = () => new Date(clock);
    const load = createUpcomingLoader(h.deps);
    const [a, b] = await Promise.all([load(['111']), load(['111'])]);
    expect(a.get('111')).toEqual({ state: 'unavailable' });
    expect(b.get('111')).toEqual({ state: 'unavailable' });
    expect(h.fetchMany).toHaveBeenCalledTimes(1);
    fail = false;
    clock += UPCOMING_UNAVAILABLE_TTL_SEC * 1000;
    const c = await load(['111']);
    expect(c.get('111')?.state).toBe('ok');
    expect(h.fetchMany).toHaveBeenCalledTimes(2);
  });

  it('ignores non-digit ids and caps at 50', async () => {
    const h = harness(async (ids) => new Map(ids.map((id) => [id, []])));
    const ids = Array.from({ length: 70 }, (_, i) => String(1000 + i));
    const out = await createUpcomingLoader(h.deps)([
      ...ids,
      'abc',
      '12 3',
      '',
      '1'.repeat(21),
      '1000',
    ]);
    expect(out.size).toBe(UPCOMING_MAX_MEMBERS);
    expect(out.has('abc')).toBe(false);
    const asked = h.fetchMany.mock.calls[0][0] as string[];
    expect(asked).toHaveLength(50);
    expect(new Set(asked).size).toBe(50);
    expect(asked.every((id) => /^[0-9]+$/.test(id))).toBe(true);
  });

  it('does not call Meetup when no id is valid', async () => {
    const h = harness(okMap([]));
    const out = await createUpcomingLoader(h.deps)(['x']);
    expect(out.size).toBe(0);
    expect(h.fetchMany).not.toHaveBeenCalled();
  });

  it('a cache read failure falls back to Meetup', async () => {
    const cache = new FakeCache();
    cache.get = async () => {
      throw new Error('redis read');
    };
    const h = harness(okMap([['111', []]]), cache);
    const out = await createUpcomingLoader(h.deps)(['111']);
    expect(out.get('111')?.state).toBe('ok');
    expect(h.fetchMany).toHaveBeenCalledTimes(1);
  });

  it('a cache write failure still returns the fetched data', async () => {
    const cache = new FakeCache();
    cache.set = async () => {
      throw new Error('redis write');
    };
    const h = harness(okMap([['111', []]]), cache);
    const out = await createUpcomingLoader(h.deps)(['111']);
    expect(out.get('111')?.state).toBe('ok');
  });

  it('a dead cache falls back to Meetup', async () => {
    const fetchMany = vi.fn(okMap([['111', []]]));
    const deps: UpcomingDeps = {
      now: () => NOW,
      cache: async () => {
        throw new Error('no redis');
      },
      fetchMany,
    };
    const out = await createUpcomingLoader(deps)(['111']);
    expect(out.get('111')?.state).toBe('ok');
    expect(fetchMany).toHaveBeenCalledTimes(1);
  });

  it('a member missing from the fetch result is unavailable, remembered for 60 s', async () => {
    const h = harness(okMap([['111', []]]));
    const load = createUpcomingLoader(h.deps);
    const out = await load(['111', '222']);
    expect(out.get('111')?.state).toBe('ok');
    expect(out.get('222')).toEqual({ state: 'unavailable' });
    expect(h.cache.ttls.get('workspace-upcoming-v1-222')).toBe(
      UPCOMING_UNAVAILABLE_TTL_SEC,
    );
    expect((await load(['222'])).get('222')).toEqual({ state: 'unavailable' });
    expect(h.fetchMany).toHaveBeenCalledTimes(1);
  });

  it('a hung batch times out after 30 seconds: unavailable for 60 s, then refetched', async () => {
    vi.useFakeTimers();
    let release!: (m: Map<string, EventSummary[] | undefined>) => void;
    const h = harness(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let clock = NOW.getTime();
    h.deps.now = () => new Date(clock);
    const load = createUpcomingLoader(h.deps);
    const first = load(['111']);
    await vi.advanceTimersByTimeAsync(UPCOMING_DEADLINE_MS);
    expect((await first).get('111')).toEqual({ state: 'pending' });
    // Still in flight: a second load does not fetch again.
    const second = load(['111']);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchMany).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPCOMING_BATCH_TIMEOUT_MS);
    expect((await second).get('111')).toEqual({ state: 'pending' });
    // The hung fetch finally answers: too late, only the failure is kept.
    release(new Map([['111', [event('e1', '2026-10-25T02:00:00Z')]]]));
    await vi.advanceTimersByTimeAsync(0);
    expect(
      (
        JSON.parse(
          h.cache.values.get('workspace-upcoming-v1-111') ?? '',
        ) as StoredShape
      ).state,
    ).toBe('unavailable');
    const third = load(['111']);
    await vi.advanceTimersByTimeAsync(0);
    expect((await third).get('111')).toEqual({ state: 'unavailable' });
    expect(h.fetchMany).toHaveBeenCalledTimes(1);
    clock += UPCOMING_UNAVAILABLE_TTL_SEC * 1000;
    const fourth = load(['111']);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchMany).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(UPCOMING_DEADLINE_MS);
    await fourth;
  });

  it('drops cached events that have started since they were cached', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T03:00:00Z'));
    const h = harness(okMap([]));
    h.deps.now = () => new Date();
    await h.cache.set(
      'workspace-upcoming-v1-111',
      JSON.stringify({
        state: 'ok',
        fetchedAt: NOW.toISOString(),
        events: [
          {
            id: 'started',
            title: 't',
            eventUrl: 'u',
            dateTime: '2026-10-26T02:00:00Z',
            payment: null,
          },
          {
            id: 'next',
            title: 't',
            eventUrl: 'u',
            dateTime: '2026-11-02T02:00:00Z',
            payment: null,
          },
        ],
      }),
    );
    const out = await createUpcomingLoader(h.deps)(['111']);
    const entry = out.get('111') as { events: { id: string }[] };
    expect(entry.events.map((e) => e.id)).toEqual(['next']);
    expect(h.fetchMany).not.toHaveBeenCalled();
    expect(actByFor(entry as UpcomingEntry, new Date())?.actBy).toBe(
      '2026-10-29',
    );
  });

  it('ignores a corrupt cached value and refetches', async () => {
    const h = harness(okMap([['111', []]]));
    await h.cache.set('workspace-upcoming-v1-111', '{not json');
    await h.cache.set(
      'workspace-upcoming-v1-222',
      JSON.stringify({ state: 'ok' }),
    );
    const out = await createUpcomingLoader(h.deps)(['111', '222']);
    expect(out.get('111')?.state).toBe('ok');
    expect(h.fetchMany).toHaveBeenCalledTimes(1);
  });
});

describe('actByFor', () => {
  const ok = (dateTime: string): UpcomingEntry => ({
    state: 'ok',
    fetchedAt: NOW.toISOString(),
    events: [{ id: 'e', title: 't', eventUrl: 'u', dateTime, payment: null }],
  });

  it('is 3 days before the earliest upcoming RSVP and says act now on the day', () => {
    // Event Oct 25 19:00 Pacific -> act by Oct 22
    const entry = ok('2026-10-26T02:00:00Z');
    expect(actByFor(entry, new Date('2026-10-17T18:00:00Z'))).toEqual({
      actBy: '2026-10-22',
      actNow: false,
    });
    expect(actByFor(entry, new Date('2026-10-22T18:00:00Z'))).toEqual({
      actBy: '2026-10-22',
      actNow: true,
    });
  });

  it('has nothing for non-ok or empty entries', () => {
    expect(actByFor({ state: 'pending' }, NOW)).toBeUndefined();
    expect(actByFor({ state: 'unavailable' }, NOW)).toBeUndefined();
    expect(actByFor({ state: 'left', fetchedAt: 'x' }, NOW)).toBeUndefined();
    expect(
      actByFor({ state: 'ok', fetchedAt: 'x', events: [] }, NOW),
    ).toBeUndefined();
  });
});

describe('organizerFetchMany (the production fetchMany)', () => {
  type Rsvps = (
    memberId: string,
    groupId: string,
    filter: unknown,
    options: unknown,
  ) => Promise<EventSummary[] | undefined>;

  function organizer(getMemberRsvpEvents: Rsvps, token = 'tok') {
    const rsvps = vi.fn(getMemberRsvpEvents);
    const getToken = vi.fn(async (_options?: unknown) => token);
    const makeClient = vi.fn(
      () => ({ getMemberRsvpEvents: rsvps }) as unknown as GqlMeetupClient,
    );
    return {
      rsvps,
      getToken,
      deps: { getToken, makeClient } as unknown as OrganizerMeetupDeps,
    };
  }

  it('answers every requested id: events, or undefined for a member who left', async () => {
    const o = organizer(async (id) => {
      if (id === '222') {
        return undefined;
      }
      return [event('9', '2026-10-20T02:00:00.000Z')];
    });
    const out = await organizerFetchMany(
      () => undefined,
      o.deps,
    )(['111', '222']);
    expect([...out.keys()]).toEqual(['111', '222']);
    expect(out.has('222')).toBe(true);
    expect(out.get('222')).toBeUndefined();
    expect(out.get('111')?.[0].id).toBe('9');
    expect(o.rsvps).toHaveBeenCalledWith(
      '111',
      expect.any(String),
      { rsvpStatus: ['YES'], eventStatus: ['UPCOMING'] },
      { withPaymentInfo: true },
    );
  });

  it("one member's Meetup failure leaves only that id out, so only that card is unavailable", async () => {
    const o = organizer(async (id) => {
      if (id === '222') {
        throw new Error('meetup down');
      }
      return [event('9', '2026-10-20T02:00:00.000Z')];
    });
    const out = await organizerFetchMany(
      () => undefined,
      o.deps,
    )(['111', '222', '333']);
    expect([...out.keys()]).toEqual(['111', '333']);
    expect(out.has('222')).toBe(false);
    const load = createUpcomingLoader({
      now: () => NOW,
      cache: async () => new FakeCache(),
      fetchMany: organizerFetchMany(() => undefined, o.deps),
    });
    const entries = await load(['111', '222']);
    expect(entries.get('111')?.state).toBe('ok');
    expect(entries.get('222')).toEqual({ state: 'unavailable' });
  });

  it('logs one warn per batch for failed reads: counts and error names, no ids or names', async () => {
    class MeetupTimeout extends Error {
      name = 'MeetupTimeout';
    }
    const o = organizer(async (id) => {
      if (id === '222' || id === '444') {
        throw new Error('meetup down for 222');
      }
      if (id === '333') {
        throw new MeetupTimeout('slow for 333');
      }
      return [];
    });
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      const out = await organizerFetchMany(
        () => undefined,
        o.deps,
      )(['111', '222', '333', '444']);
      expect([...out.keys()]).toEqual(['111']);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toEqual([
        'Upcoming RSVP reads failed for 3 of 4 members: Error, MeetupTimeout',
      ]);
      for (const id of ['111', '222', '333', '444']) {
        expect(lines.join('\n')).not.toContain(id);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('a batch with no failed reads logs no warn', async () => {
    const o = organizer(async () => []);
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      await organizerFetchMany(() => undefined, o.deps)(['111', '222']);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a 401 rejects the whole batch, so the organizer client refreshes once and retries', async () => {
    let calls = 0;
    const o = organizer(async (id) => {
      calls += 1;
      if (calls === 1) {
        throw new ClientError(
          { status: 401, headers: new Headers(), body: '' },
          { query: '' },
        );
      }
      return id === '222' ? undefined : [];
    });
    const out = await organizerFetchMany(
      () => undefined,
      o.deps,
    )(['111', '222']);
    expect(o.getToken).toHaveBeenCalledTimes(2);
    expect(o.getToken.mock.calls[1][0]).toMatchObject({ forceRefresh: true });
    expect([...out.keys()]).toEqual(['111', '222']);
  });

  it('a 401 on the retry rejects', async () => {
    const o = organizer(async () => {
      throw new ClientError(
        { status: 401, headers: new Headers(), body: '' },
        { query: '' },
      );
    });
    await expect(
      organizerFetchMany(() => undefined, o.deps)(['111']),
    ).rejects.toBeInstanceOf(ClientError);
  });

  it('rejects when there is no organizer login', async () => {
    const o = organizer(async () => [], '');
    await expect(
      organizerFetchMany(() => undefined, o.deps)(['111']),
    ).rejects.toThrow(OrganizerTokenUnavailableError);
    expect(o.rsvps).not.toHaveBeenCalled();
  });

  it('end to end: a Meetup failure through the loader is unavailable, remembered for 60 s', async () => {
    const o = organizer(async () => {
      throw new Error('meetup down');
    });
    const cache = new FakeCache();
    const load = createUpcomingLoader({
      now: () => NOW,
      cache: async () => cache,
      fetchMany: organizerFetchMany(() => undefined, o.deps),
    });
    const out = await load(['111']);
    expect(out.get('111')).toEqual({ state: 'unavailable' });
    expect(cache.ttls.get('workspace-upcoming-v1-111')).toBe(
      UPCOMING_UNAVAILABLE_TTL_SEC,
    );
    await load(['111']);
    expect(o.rsvps).toHaveBeenCalledTimes(1);
  });

  it('end to end: a 401 refreshes and retries first; only the final failure is remembered', async () => {
    const o = organizer(async () => {
      throw new ClientError(
        { status: 401, headers: new Headers(), body: '' },
        { query: '' },
      );
    });
    const cache = new FakeCache();
    const load = createUpcomingLoader({
      now: () => NOW,
      cache: async () => cache,
      fetchMany: organizerFetchMany(() => undefined, o.deps),
    });
    expect((await load(['111'])).get('111')).toEqual({ state: 'unavailable' });
    // The first read, then the retry after one forced refresh.
    expect(o.getToken).toHaveBeenCalledTimes(2);
    expect(o.getToken.mock.calls[1][0]).toMatchObject({ forceRefresh: true });
    expect(o.rsvps).toHaveBeenCalledTimes(2);
    expect(cache.ttls.get('workspace-upcoming-v1-111')).toBe(
      UPCOMING_UNAVAILABLE_TTL_SEC,
    );
    await load(['111']);
    expect(o.rsvps).toHaveBeenCalledTimes(2);
    expect(o.getToken).toHaveBeenCalledTimes(2);
  });
});

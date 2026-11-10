import dayjs from 'dayjs';
import { describe, expect, it, vi } from 'vitest';

import { GUEST_HOST_MEETUP_BLACKLIST } from '../../../src/constants.js';
import { HostEvent } from '../../../src/lib/hosts/hostEvents.js';
import {
  PROMOTION_MIN_EVENTS,
  hostsSeen,
  promotionCandidates,
  singleFlight,
} from '../../../src/lib/hosts/promotionCandidates.js';

const NOW = new Date('2026-11-10T20:00:00Z');

const event = (
  id: string,
  dateTime: string,
  hosts: { id: string; name: string }[],
): HostEvent => ({
  id,
  title: `Event ${id}`,
  dateTime,
  eventUrl: `https://www.meetup.com/g/events/${id}/`,
  type: 'social',
  counted: true,
  hosts,
});

const A = { id: '111', name: 'Ann' };
const B = { id: '222', name: 'Bo' };
const C = { id: '333', name: 'Cy' };

describe('hostsSeen', () => {
  it('keeps each host once, with their latest event, and skips bad ids', () => {
    const seen = hostsSeen([
      event('1', '2026-03-01T19:00:00-08:00', [A, B]),
      event('2', '2026-09-01T19:00:00-07:00', [A]),
      event('3', '2026-05-01T19:00:00-07:00', [{ id: '', name: 'Nobody' }]),
    ]);
    expect([...seen.keys()]).toEqual(['111', '222']);
    expect(seen.get('111')?.lastHosted).toBe('2026-09-01T19:00:00-07:00');
  });
});

describe('promotionCandidates', () => {
  /** `n` counted events hosted by `host`, one a week back from May 2026. */
  const weekly = (host: { id: string; name: string }, n: number, from = 20) =>
    Array.from({ length: n }, (_, i) =>
      event(
        `${host.id}-${i}`,
        dayjs('2026-05-01T19:00:00-07:00')
          .subtract(from + i, 'week')
          .toISOString(),
        [host],
      ),
    );
  const JOINED_LONG_AGO = '2020-01-01T12:00:00-08:00';

  function deps(
    events: HostEvent[],
    options: {
      memberships?: Record<string, { status: string; joinTime: string }>;
      organizers?: string[];
      allTime?: Record<string, HostEvent[]>;
    } = {},
  ) {
    const memberships = options.memberships ?? {
      '111': { status: 'ACTIVE', joinTime: JOINED_LONG_AGO },
      '222': { status: 'ACTIVE', joinTime: JOINED_LONG_AGO },
      '333': { status: 'ACTIVE', joinTime: JOINED_LONG_AGO },
    };
    return {
      now: () => NOW,
      fetchGroupEvents: vi.fn(async () => events),
      pastHostedEvents: vi.fn(async (id: string) => {
        return (
          options.allTime?.[id] ??
          events.filter((e) => e.hosts.some((h) => h.id === id))
        );
      }),
      memberships: vi.fn(async (ids: string[]) => {
        const found = ids.filter((id) => memberships[id] !== undefined);
        return new Map(found.map((id) => [id, memberships[id]] as const));
      }),
      isOrganizer: vi.fn(async (id: string) =>
        (options.organizers ?? []).includes(id),
      ),
    };
  }

  it('reads 18 months of PAST events and lists hosts with 20+ counted ones, most recent events first', async () => {
    const d = deps(
      [
        ...weekly(A, 25),
        ...weekly(B, PROMOTION_MIN_EVENTS),
        ...weekly(C, PROMOTION_MIN_EVENTS - 1),
      ],
      { allTime: { '111': weekly(A, 40, 0) } },
    );
    const { candidates } = await promotionCandidates(d, new Set());
    expect(d.fetchGroupEvents).toHaveBeenCalledWith({
      status: ['PAST'],
      afterDateTime: '2025-05-10T20:00:00.000Z',
      beforeDateTime: NOW.toISOString(),
    });
    expect(
      candidates.map((c) => [c.meetupMemberId, c.recentCount, c.pastCount]),
    ).toEqual([
      ['111', 25, 40],
      ['222', 20, 20],
    ]);
    expect(candidates[0].memberSince).toBe(JOINED_LONG_AGO);
    // Only the hosts with enough events are looked up any further.
    expect(d.memberships).toHaveBeenCalledWith(['111', '222']);
    expect(d.pastHostedEvents).not.toHaveBeenCalledWith('333');
  });

  it('cancelled events and Open Houses do not count toward the 20', async () => {
    const counted = weekly(A, PROMOTION_MIN_EVENTS - 1);
    const d = deps([
      ...counted,
      { ...event('x', '2026-04-01T19:00:00-07:00', [A]), counted: false },
      { ...event('y', '2026-04-02T19:00:00-07:00', [A]), counted: false },
    ]);
    const { candidates } = await promotionCandidates(d, new Set());
    expect(candidates).toEqual([]);
  });

  it('leaves out organizers: Meetup LEADER status, or the Organizer Discord role', async () => {
    const d = deps([...weekly(A, 25), ...weekly(B, 25)], {
      memberships: {
        '111': { status: 'LEADER', joinTime: JOINED_LONG_AGO },
        '222': { status: 'ACTIVE', joinTime: JOINED_LONG_AGO },
      },
      organizers: ['222'],
    });
    const { candidates, uncounted } = await promotionCandidates(d, new Set());
    expect(candidates).toEqual([]);
    expect(uncounted).toBe(0);
    // A LEADER is settled by Meetup alone; nothing else is read for them.
    expect(d.isOrganizer).not.toHaveBeenCalledWith('111');
    expect(d.pastHostedEvents).not.toHaveBeenCalledWith('222');
  });

  it('needs a year of membership, and a host who left the group is not listed', async () => {
    const d = deps([...weekly(A, 25), ...weekly(B, 25), ...weekly(C, 25)], {
      memberships: {
        '111': { status: 'ACTIVE', joinTime: '2025-11-11T00:00:00Z' },
        '222': { status: 'ACTIVE', joinTime: '2025-11-09T00:00:00Z' },
      },
    });
    const { candidates } = await promotionCandidates(d, new Set());
    expect(candidates.map((c) => c.meetupMemberId)).toEqual(['222']);
  });

  it('leaves out the excluded and the blacklisted without looking them up', async () => {
    const banned = { id: GUEST_HOST_MEETUP_BLACKLIST[0], name: 'Banned' };
    const d = deps([...weekly(A, 25), ...weekly(B, 25), ...weekly(banned, 25)]);
    const { candidates, seen } = await promotionCandidates(d, new Set(['111']));
    expect(candidates.map((c) => c.meetupMemberId)).toEqual(['222']);
    expect(d.memberships).toHaveBeenCalledWith(['222']);
    expect(d.pastHostedEvents).not.toHaveBeenCalledWith('111');
    // Still known by name, for the Community Hosts table.
    expect(seen.get('111')?.name).toBe('Ann');
  });

  it('a host whose own lookup fails is left out and counted, not the whole list', async () => {
    const d = deps([...weekly(A, 25), ...weekly(B, 25)]);
    d.pastHostedEvents.mockRejectedValueOnce(new Error('meetup down'));
    const list = await promotionCandidates(d, new Set());
    expect(list.uncounted).toBe(1);
    expect(list.candidates).toHaveLength(1);
  });

  it('the event or membership read failing fails the list', async () => {
    const d = deps(weekly(A, 25));
    d.fetchGroupEvents.mockRejectedValueOnce(new Error('meetup down'));
    await expect(promotionCandidates(d, new Set())).rejects.toThrow(
      'meetup down',
    );
    const e = deps(weekly(A, 25));
    e.memberships.mockRejectedValueOnce(new Error('meetup down'));
    await expect(promotionCandidates(e, new Set())).rejects.toThrow(
      'meetup down',
    );
  });

  it('nobody with enough events: no membership read at all', async () => {
    const d = deps(weekly(A, 3));
    const list = await promotionCandidates(d, new Set());
    expect(list.candidates).toEqual([]);
    expect(d.memberships).not.toHaveBeenCalled();
  });
});

describe('singleFlight', () => {
  it('one read for callers at once, kept until the TTL', async () => {
    let clock = 0;
    let release: ((v: number) => void) | undefined;
    const read = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    const get = singleFlight(read, 1000, { now: () => clock });
    const one = get();
    const two = get();
    release?.(7);
    expect(await Promise.all([one, two])).toEqual([7, 7]);
    clock = 999;
    expect(await get()).toBe(7);
    expect(read).toHaveBeenCalledTimes(1);
    clock = 1000;
    const three = get();
    release?.(8);
    expect(await three).toBe(8);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a failure is not kept', async () => {
    const read = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(5);
    const get = singleFlight(read, 1000, { now: () => 0 });
    await expect(get()).rejects.toThrow('down');
    expect(await get()).toBe(5);
  });

  it('a value keep refuses is returned but not kept', async () => {
    const read = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    const get = singleFlight(read, 1000, {
      now: () => 0,
      keep: (v) => v > 1,
    });
    expect(await get()).toBe(1);
    expect(await get()).toBe(2);
    expect(await get()).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a hung read times out and frees the slot for the next caller', async () => {
    const read = vi
      .fn<() => Promise<number>>()
      .mockImplementationOnce(() => new Promise<number>(() => undefined))
      .mockResolvedValueOnce(9);
    const get = singleFlight(read, 1000, { timeoutMs: 20 });
    await expect(get()).rejects.toThrow('timed out');
    expect(await get()).toBe(9);
  });

  it('a timed-out read that finishes late does not replace a newer list', async () => {
    let finishLate: ((v: number) => void) | undefined;
    const read = vi
      .fn<() => Promise<number>>()
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            finishLate = resolve;
          }),
      )
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);
    let clock = 0;
    const get = singleFlight(read, 1000, { timeoutMs: 20, now: () => clock });
    await expect(get()).rejects.toThrow('timed out');
    expect(await get()).toBe(2);
    // The first read answers now, long after it timed out.
    clock = 500;
    finishLate?.(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(await get()).toBe(2);
    // The newer list's TTL was not restarted by the late one either.
    clock = 1000;
    expect(await get()).toBe(3);
    expect(read).toHaveBeenCalledTimes(3);
  });
});

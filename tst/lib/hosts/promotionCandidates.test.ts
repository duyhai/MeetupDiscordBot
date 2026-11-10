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
  const counts: Record<string, number> = {
    '111': 25,
    '222': PROMOTION_MIN_EVENTS,
    '333': PROMOTION_MIN_EVENTS - 1,
  };

  function deps(events: HostEvent[]) {
    return {
      now: () => NOW,
      fetchGroupEvents: vi.fn(async () => events),
      pastHostedCount: vi.fn(async (id: string) => counts[id] ?? 0),
    };
  }

  it('reads the past year of PAST events, counts every host and keeps 20+, most first', async () => {
    const d = deps([
      event('1', '2026-03-01T19:00:00-08:00', [B, C]),
      event('2', '2026-09-01T19:00:00-07:00', [A]),
    ]);
    const { candidates } = await promotionCandidates(d, new Set());
    expect(d.fetchGroupEvents).toHaveBeenCalledWith({
      status: ['PAST'],
      afterDateTime: '2025-11-10T20:00:00.000Z',
      beforeDateTime: NOW.toISOString(),
    });
    expect(candidates.map((c) => [c.meetupMemberId, c.pastCount])).toEqual([
      ['111', 25],
      ['222', 20],
    ]);
  });

  it('leaves out the excluded and the blacklisted without counting them', async () => {
    const banned = { id: GUEST_HOST_MEETUP_BLACKLIST[0], name: 'Banned' };
    const d = deps([event('1', '2026-03-01T19:00:00-08:00', [A, B, banned])]);
    const { candidates, seen } = await promotionCandidates(d, new Set(['111']));
    expect(candidates.map((c) => c.meetupMemberId)).toEqual(['222']);
    expect(d.pastHostedCount).not.toHaveBeenCalledWith('111');
    expect(d.pastHostedCount).not.toHaveBeenCalledWith(banned.id);
    // Still known by name, for the Community Hosts table.
    expect(seen.get('111')?.name).toBe('Ann');
  });

  it('a count that fails leaves that host out and is counted, not the whole list', async () => {
    const d = deps([event('1', '2026-03-01T19:00:00-08:00', [A, B])]);
    d.pastHostedCount.mockRejectedValueOnce(new Error('meetup down'));
    const list = await promotionCandidates(d, new Set());
    expect(list.uncounted).toBe(1);
    expect(list.candidates).toHaveLength(1);
  });

  it('the event read failing fails the list', async () => {
    const d = deps([]);
    d.fetchGroupEvents.mockRejectedValueOnce(new Error('meetup down'));
    await expect(promotionCandidates(d, new Set())).rejects.toThrow(
      'meetup down',
    );
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

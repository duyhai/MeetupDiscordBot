import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cachedHostedCounts,
  looksRateLimited,
} from '../../src/web/hostedCounts.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A read the test settles by hand. */
function controlled() {
  const pending = new Map<
    string,
    { resolve: (n: number) => void; reject: (e: unknown) => void }
  >();
  const read = vi.fn(
    (id: string) =>
      new Promise<number>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      }),
  );
  return { read, pending };
}

describe('cachedHostedCounts', () => {
  it('reads each host once, keeps the count for the TTL, evicts it after', async () => {
    const read = vi.fn(async (id: string) => Number(id) * 2);
    const counts = cachedHostedCounts(read, { ttlMs: 100 });
    expect(await counts(['1', '2', '1'])).toEqual(
      new Map([
        ['1', 2],
        ['2', 4],
      ]),
    );
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(99);
    await counts(['1', '2']);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await counts(['1']);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('answers within the 3 s budget; the slow host lands in the cache for the next load', async () => {
    const { read, pending } = controlled();
    const counts = cachedHostedCounts(read);
    const page = counts(['slow']);
    await vi.advanceTimersByTimeAsync(2_999);
    let done = false;
    void page.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await page).toEqual(new Map());
    pending.get('slow')?.resolve(9);
    await vi.advanceTimersByTimeAsync(0);
    expect(await counts(['slow'])).toEqual(new Map([['slow', 9]]));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a failed host cools down: not read again within the window, then retried', async () => {
    const read = vi.fn(async () => {
      throw new Error('meetup 500');
    });
    const counts = cachedHostedCounts(read, { cooldownMs: 1_000 });
    expect(await counts(['1'])).toEqual(new Map());
    await counts(['1']);
    await vi.advanceTimersByTimeAsync(999);
    await counts(['1']);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await counts(['1']);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a read that throws synchronously, or returns junk, never rejects and is not kept', async () => {
    const read = vi.fn((id: string): Promise<number> => {
      if (id === 'sync') {
        throw new Error('boom');
      }
      return Promise.resolve(id === 'nan' ? Number.NaN : 1);
    });
    const counts = cachedHostedCounts(read);
    expect(await counts(['sync', 'nan', 'ok'])).toEqual(new Map([['ok', 1]]));
  });

  it('a hung read frees its slot at the timeout: with 4 hung, a 5th host still reads', async () => {
    const { read, pending } = controlled();
    const counts = cachedHostedCounts(read, {
      readTimeoutMs: 10_000,
      budgetMs: 100_000,
    });
    const page = counts(['a', 'b', 'c', 'd', 'e']);
    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c', 'd']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read.mock.calls.map((c) => c[0])).toContain('e');
    pending.get('e')?.resolve(5);
    expect(await page).toEqual(new Map([['e', 5]]));
  });

  it('a timed-out host is not read again while its read still runs, and its late result is dropped', async () => {
    const { read, pending } = controlled();
    const counts = cachedHostedCounts(read, {
      readTimeoutMs: 10,
      cooldownMs: 50,
      budgetMs: 1_000,
    });
    const first = counts(['a']);
    await vi.advanceTimersByTimeAsync(10);
    expect(await first).toEqual(new Map());
    // Cooldown over, read still hung: no second read, and no waiting on it.
    await vi.advanceTimersByTimeAsync(100);
    expect(await counts(['a'])).toEqual(new Map());
    expect(read).toHaveBeenCalledTimes(1);
    pending.get('a')?.resolve(7);
    await vi.advanceTimersByTimeAsync(0);
    // The late 7 was dropped; the next load reads afresh.
    const again = counts(['a']);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    pending.get('a')?.resolve(8);
    expect(await again).toEqual(new Map([['a', 8]]));
  });

  it('caps reads at 4 across concurrent pages, and a host is read once at a time', async () => {
    const { read, pending } = controlled();
    const counts = cachedHostedCounts(read, { budgetMs: 100_000 });
    const one = counts(['1', '2', '3']);
    const two = counts(['3', '4', '5', '6']);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.calls.filter((c) => c[0] === '3')).toHaveLength(1);
    pending.get('1')?.resolve(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(5);
    for (const id of ['2', '3', '4']) {
      pending.get(id)?.resolve(Number(id));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(6);
    for (const id of ['5', '6']) {
      pending.get(id)?.resolve(Number(id));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect((await one).size).toBe(3);
    expect((await two).size).toBe(4);
  });

  it('a 429 cools that host, drops the queued reads (their waiters answer at once) and pauses the cache', async () => {
    const rateLimited = Object.assign(new Error('Too Many Requests'), {
      status: 429,
    });
    const read = vi.fn(async (id: string) => {
      if (id === '1' && read.mock.calls.length === 1) {
        throw rateLimited;
      }
      return Number(id);
    });
    const counts = cachedHostedCounts(read, {
      concurrency: 1,
      cooldownMs: 1_000,
      budgetMs: 100_000,
    });
    // Answers without waiting for the 100 s budget: the dropped hosts' waiters resolved.
    let done = false;
    const page = counts(['1', '2', '3']).then((m) => {
      done = true;
      return m;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(await page).toEqual(new Map());
    expect(read).toHaveBeenCalledTimes(1);
    // Paused: another page, other hosts, still no Meetup call.
    await vi.advanceTimersByTimeAsync(999);
    expect(await counts(['4', '5'])).toEqual(new Map());
    expect(read).toHaveBeenCalledTimes(1);
    // The pause and host 1's cooldown are over: everyone is read.
    await vi.advanceTimersByTimeAsync(1);
    const after = counts(['1', '4']);
    await vi.advanceTimersByTimeAsync(0);
    expect(await after).toEqual(
      new Map([
        ['1', 1],
        ['4', 4],
      ]),
    );
  });

  it('a host that failed is read again after its cooldown, and that count is kept', async () => {
    let fail = true;
    const read = vi.fn(async () => {
      if (fail) {
        throw new Error('meetup 500');
      }
      return 6;
    });
    const counts = cachedHostedCounts(read, { cooldownMs: 1_000 });
    expect(await counts(['1'])).toEqual(new Map());
    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await counts(['1'])).toEqual(new Map([['1', 6]]));
    expect(await counts(['1'])).toEqual(new Map([['1', 6]]));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('cached counts still show while the cache is paused', async () => {
    const read = vi.fn(async (id: string) => {
      if (id === 'limited') {
        throw Object.assign(new Error('x'), { status: 429 });
      }
      return 3;
    });
    const counts = cachedHostedCounts(read, { concurrency: 1 });
    expect(await counts(['known'])).toEqual(new Map([['known', 3]]));
    await counts(['limited']);
    expect(await counts(['known', 'other'])).toEqual(new Map([['known', 3]]));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('asks about at most maxHosts hosts per page', async () => {
    const read = vi.fn(async () => 1);
    const counts = cachedHostedCounts(read, { maxHosts: 10 });
    const ids = Array.from({ length: 30 }, (_, i) => String(i));
    expect((await counts(ids)).size).toBe(10);
    expect(read).toHaveBeenCalledTimes(10);
  });

  it('recognises a rate limit by status or message', () => {
    expect(looksRateLimited({ status: 429 })).toBe(true);
    expect(looksRateLimited({ response: { status: 429 } })).toBe(true);
    expect(looksRateLimited(new Error('HTTP 429'))).toBe(true);
    expect(looksRateLimited(new Error('Too Many Requests'))).toBe(true);
    expect(looksRateLimited(new Error('server error 500'))).toBe(false);
    // A numeric status decides; the message (Meetup's body) is not read.
    expect(
      looksRateLimited(
        Object.assign(new Error('upstream said 429 rate limit'), {
          status: 500,
        }),
      ),
    ).toBe(false);
    expect(
      looksRateLimited(
        Object.assign(new Error('rate limit'), { response: { status: 502 } }),
      ),
    ).toBe(false);
    expect(looksRateLimited(undefined)).toBe(false);
  });
});

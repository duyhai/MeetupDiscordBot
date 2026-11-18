import { describe, expect, it, vi } from 'vitest';

import { cachedHostedCounts } from '../../src/web/hostedCounts.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('cachedHostedCounts', () => {
  it('reads each host once and keeps the count for the TTL', async () => {
    let clock = 0;
    const read = vi.fn(async (id: string) => Number(id) * 2);
    const counts = cachedHostedCounts(read, { now: () => clock, ttlMs: 100 });
    expect(await counts(['1', '2', '1'])).toEqual(
      new Map([
        ['1', 2],
        ['2', 4],
      ]),
    );
    expect(read).toHaveBeenCalledTimes(2);
    clock = 99;
    await counts(['1', '2']);
    expect(read).toHaveBeenCalledTimes(2);
    clock = 100;
    await counts(['1']);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('answers within the budget; a slow host is absent now and cached for the next load', async () => {
    let finish: (n: number) => void = () => undefined;
    const read = vi.fn(async (id: string) => {
      if (id !== 'slow') {
        return 3;
      }
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    });
    const counts = cachedHostedCounts(read, { budgetMs: 20 });
    const first = await counts(['fast', 'slow']);
    expect(first).toEqual(new Map([['fast', 3]]));
    finish(9);
    await flush();
    expect(await counts(['fast', 'slow'])).toEqual(
      new Map([
        ['fast', 3],
        ['slow', 9],
      ]),
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a hung read is dropped after its timeout, so the next load asks again', async () => {
    const read = vi.fn(async () => new Promise<number>(() => undefined));
    const counts = cachedHostedCounts(read, { budgetMs: 5, readTimeoutMs: 15 });
    expect(await counts(['1'])).toEqual(new Map());
    await counts(['1']);
    expect(read).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await counts(['1']);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a failing read is absent and never rejects; bad numbers are not kept', async () => {
    const read = vi.fn(async (id: string) => {
      if (id === 'bad') {
        throw new Error('meetup down');
      }
      return id === 'nan' ? Number.NaN : 1;
    });
    const counts = cachedHostedCounts(read);
    expect(await counts(['bad', 'nan', 'ok'])).toEqual(new Map([['ok', 1]]));
  });

  it('asks about at most maxHosts hosts per page, a few at a time', async () => {
    let running = 0;
    let peak = 0;
    const read = vi.fn(async () => {
      running++;
      peak = Math.max(peak, running);
      await flush();
      running--;
      return 1;
    });
    const counts = cachedHostedCounts(read, { maxHosts: 10 });
    const ids = Array.from({ length: 30 }, (_, i) => String(i));
    expect((await counts(ids)).size).toBe(10);
    expect(read).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

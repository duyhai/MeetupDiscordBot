import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from '../../../../src/lib/client/meetup/paginationHelper.js';

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const items = [30, 10, 20];
    const results = await mapWithConcurrency(items, 3, async (item) => {
      await new Promise((resolve) => {
        setTimeout(resolve, item);
      });
      return item;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it('never runs more than `limit` calls at once', async () => {
    const items = Array.from({ length: 20 }, (_unused, index) => index);
    let inFlight = 0;
    let maxInFlight = 0;
    const limit = 5;

    await mapWithConcurrency(items, limit, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      inFlight -= 1;
      return item;
    });

    expect(maxInFlight).toBeLessThanOrEqual(limit);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('handles an empty input list', async () => {
    const results = await mapWithConcurrency<number, number>(
      [],
      5,
      async (item) => item,
    );
    expect(results).toEqual([]);
  });

  it('handles a limit larger than the input list', async () => {
    const results = await mapWithConcurrency(
      [1, 2],
      10,
      async (item) => item * 2,
    );
    expect(results).toEqual([2, 4]);
  });

  it('stops starting new work once any call rejects', async () => {
    // The caller has already received the rejection by the time the other
    // workers finish their current call, so anything they start afterwards is
    // a wasted Meetup request whose result nobody reads.
    const started: number[] = [];
    const items = Array.from({ length: 10 }, (_unused, index) => index);

    await expect(
      mapWithConcurrency(items, 2, async (item) => {
        started.push(item);
        if (item === 0) {
          throw new Error('boom');
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
        return item;
      }),
    ).rejects.toThrow('boom');

    // Let the surviving worker finish its in-flight call and reach its next
    // pull; without fail-fast it would drain all ten items here.
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(started).toEqual([0, 1]);
  });

  it.each([0, -1, Number.NaN])(
    'rejects an invalid limit of %s rather than returning undefined results',
    async (limit) => {
      let called = false;
      await expect(
        mapWithConcurrency([1, 2], limit, async (item) => {
          called = true;
          return item;
        }),
      ).rejects.toThrow(RangeError);
      expect(called).toBe(false);
    },
  );
});

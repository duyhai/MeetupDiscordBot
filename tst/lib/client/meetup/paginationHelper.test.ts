import { describe, expect, it, vi } from 'vitest';

import {
  PaginationCapError,
  getPaginatedData,
  mapWithConcurrency,
} from '../../../../src/lib/client/meetup/paginationHelper.js';
import {
  PaginatedData,
  PaginationInput,
} from '../../../../src/lib/client/meetup/types.js';

type FakeCall = (input: PaginationInput) => Promise<PaginatedData<string>>;

function page(
  nodes: string[],
  pageInfo: { endCursor: string | undefined; hasNextPage: boolean },
): PaginatedData<string> {
  return {
    edges: nodes.map((node) => ({ node })),
    pageInfo: {
      endCursor: pageInfo.endCursor,
      hasNextPage: pageInfo.hasNextPage,
      hasPreviousPage: false,
      startCursor: 'start',
    },
    totalCount: nodes.length,
  };
}

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

describe('getPaginatedData', () => {
  it('walks every page and concatenates the nodes', async () => {
    const call = vi
      .fn<FakeCall>()
      .mockResolvedValueOnce(
        page(['a', 'b'], { endCursor: 'c1', hasNextPage: true }),
      )
      .mockResolvedValueOnce(
        page(['c'], { endCursor: 'c2', hasNextPage: false }),
      );

    expect(await getPaginatedData(call)).toEqual(['a', 'b', 'c']);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('passes the previous page cursor as `after`', async () => {
    const call = vi
      .fn<FakeCall>()
      .mockResolvedValueOnce(
        page(['a'], { endCursor: 'c1', hasNextPage: true }),
      )
      .mockResolvedValueOnce(
        page(['b'], { endCursor: 'c2', hasNextPage: false }),
      );

    await getPaginatedData(call);

    expect(call.mock.calls[0][0].after).toBeUndefined();
    expect(call.mock.calls[1][0].after).toBe('c1');
  });

  it('stops when the cursor does not advance', async () => {
    // The runaway shape: the API insists there is another page but hands back
    // the same cursor, so `after` never moves and page 1 is re-fetched
    // forever, accumulating into one array until the dyno is OOM-killed --
    // inside the digest, while the day-claim is held.
    const call = vi
      .fn<FakeCall>()
      .mockResolvedValue(
        page(['a'], { endCursor: 'stuck', hasNextPage: true }),
      );

    const result = await getPaginatedData(call);

    expect(call.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result).toEqual(['a', 'a']);
  });

  it('stops when hasNextPage is true but the cursor is missing', async () => {
    const call = vi
      .fn<FakeCall>()
      .mockResolvedValue(
        page(['a'], { endCursor: undefined, hasNextPage: true }),
      );

    expect(await getPaginatedData(call)).toEqual(['a']);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('still accepts a null cursor on a legitimate final page', async () => {
    // Normal APIs report a null endCursor on the last page; the guard above
    // must not turn that into a truncated result or an error.
    const call = vi
      .fn<FakeCall>()
      .mockResolvedValue(
        page(['a'], { endCursor: undefined, hasNextPage: false }),
      );

    expect(await getPaginatedData(call)).toEqual(['a']);
  });

  it('throws a named error when the page cap is exceeded', async () => {
    // A cursor that advances every page but never terminates: the cap is the
    // only thing standing between this and unbounded memory growth.
    let n = 0;
    const call = vi.fn<FakeCall>().mockImplementation(async () => {
      n += 1;
      return page([`n${n}`], { endCursor: `c${n}`, hasNextPage: true });
    });

    await expect(getPaginatedData(call)).rejects.toBeInstanceOf(
      PaginationCapError,
    );
    // Named so the digest's per-sweep handler can say what went wrong.
    await expect(getPaginatedData(call)).rejects.toThrow(/200 pages/);
  });

  it('does not throw at exactly the cap when the last page ends cleanly', async () => {
    let n = 0;
    const call = vi.fn<FakeCall>().mockImplementation(async () => {
      n += 1;
      return page([`n${n}`], { endCursor: `c${n}`, hasNextPage: n < 200 });
    });

    // Off-by-one guard: a run that legitimately fills the cap must succeed.
    expect(await getPaginatedData(call)).toHaveLength(200);
  });
});

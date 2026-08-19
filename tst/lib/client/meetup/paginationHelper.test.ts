import { describe, expect, it, vi } from 'vitest';

import {
  PaginationCapError,
  getPaginatedData,
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

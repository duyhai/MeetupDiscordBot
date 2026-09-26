import { PaginatedData, PaginationInput } from './types.js';

const PAGINATION_SIZE = 100;

/**
 * Maps `items` through `fn` with at most `limit` calls in flight at once,
 * preserving input order in the result. Used to bound fan-out calls (e.g.
 * one paginated RSVP fetch per event) that would otherwise all fire in
 * parallel and risk overwhelming the upstream API.
 */
export async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  limit: number,
  fn: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results: TOutput[] = Array.from({ length: items.length });
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// TODO: Add option to limit and also a processing callback
export async function getPaginatedData<TOutput>(
  paginatedCall: (
    paginationInput: PaginationInput,
  ) => Promise<PaginatedData<TOutput>>,
): Promise<TOutput[]> {
  let cursor: string | undefined;
  const results: TOutput[] = [];
  let pageResult: PaginatedData<TOutput> | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop
    pageResult = await paginatedCall({
      after: cursor,
      first: PAGINATION_SIZE,
    });
    cursor = pageResult.pageInfo.endCursor;
    results.push(...pageResult.edges.map((edge) => edge.node));
  } while (pageResult.pageInfo.hasNextPage);
  return results;
}

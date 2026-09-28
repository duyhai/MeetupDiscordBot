import { PaginatedData, PaginationInput } from './types.js';

const PAGINATION_SIZE = 100;

/**
 * Maps `items` through `fn` with at most `limit` calls in flight at once,
 * preserving input order in the result. Used to bound fan-out calls (e.g.
 * one paginated RSVP fetch per event) that would otherwise all fire in
 * parallel and risk overwhelming the upstream API.
 *
 * Fails fast: once any call rejects, the result is rejected and the other
 * workers stop pulling new items, rather than spending the rest of the queue
 * on requests whose results nobody will read.
 */
export async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  limit: number,
  fn: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  // Zero, negative, or NaN would spawn no workers and silently return an
  // array of undefined typed as real results.
  if (!(limit >= 1)) {
    throw new RangeError(`mapWithConcurrency limit must be >= 1, got ${limit}`);
  }
  const results: TOutput[] = Array.from({ length: items.length });
  let nextIndex = 0;
  let failed = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (failed) {
        return;
      }
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        results[currentIndex] = await fn(items[currentIndex], currentIndex);
      } catch (error) {
        failed = true;
        throw error;
      }
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

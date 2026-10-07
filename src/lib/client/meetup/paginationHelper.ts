import { PaginatedData, PaginationInput } from './types.js';

const PAGINATION_SIZE = 100;

/**
 * Hard stop on the number of pages one call will walk.
 *
 * 200 pages at 100 per page is 20,000 records -- more than three times the
 * ~6,000-member Meetup roster, the largest thing this helper is pointed at,
 * so no healthy caller can reach it. It exists for the unhealthy case: this
 * loop runs inside the identity digest while the day-claim is held, and an
 * unbounded loop there accumulates every page into one array until the dyno
 * is OOM-killed -- which releases nothing and reports nothing.
 */
const MAX_PAGES = 200;

/**
 * Thrown when pagination hits the page cap. Named rather than a bare Error so
 * the digest's per-sweep handler can report "the roster walk ran away" as a
 * degraded sweep instead of a mystery failure.
 */
export class PaginationCapError extends Error {
  /**
   * This message is composed here, not lifted from an API response, so it is
   * safe to show organizers. The digest's degraded-sweep alert surfaces the
   * message of errors carrying this marker and only the class name of the
   * rest, because a raw Meetup response body must never reach Discord.
   */
  readonly organizerSafeMessage = true;

  constructor(pages: number, collected: number) {
    super(
      `Pagination exceeded ${pages} pages (${collected} records collected) -- ` +
        'refusing to continue. The API is very likely not advancing its cursor.',
    );
    this.name = 'PaginationCapError';
  }
}

/**
 * Thrown when the API claims another page exists but the cursor is absent or
 * has not moved. Silently returning the partial roster here hid mid-walk
 * truncation: a stall on page 2 of 60 dropped 58 pages while every caller
 * believed it had everything. Named like PaginationCapError so the digest's
 * per-sweep handler can report a degraded sweep instead of a mystery failure.
 */
export class PaginationStallError extends Error {
  /** See PaginationCapError: composed here, never from an API response. */
  readonly organizerSafeMessage = true;

  constructor(pages: number, collected: number) {
    super(
      `Pagination stalled after ${pages} pages (${collected} records collected) -- ` +
        'the API claims another page but the cursor is absent or unmoved.',
    );
    this.name = 'PaginationStallError';
  }
}

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

  // The cap is the loop bound rather than a check inside it, so there is no
  // path on which this function can iterate forever.
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const pageResult = await paginatedCall({
      after: cursor,
      first: PAGINATION_SIZE,
    });
    const previousCursor = cursor;
    cursor = pageResult.pageInfo.endCursor;

    // `hasNextPage: true` with a cursor that is absent or has not moved is
    // the API contradicting itself. Following it re-requests the same page
    // forever: the same `after` yields the same page, which again claims a
    // next page. Returning the partial roster silently is just as bad -- a
    // stall mid-walk truncates everything after it while the caller believes
    // it has the full set -- so the stall throws, like the page cap. An
    // unmoved cursor means this page is a re-serve of the previous one, so
    // its nodes are duplicates and are not counted as collected. Reached
    // only when hasNextPage is true, so a normal final page -- which
    // routinely reports a null cursor -- is unaffected.
    const stalled =
      pageResult.pageInfo.hasNextPage && (!cursor || cursor === previousCursor);
    const isDuplicatePage =
      stalled && previousCursor !== undefined && cursor === previousCursor;
    if (!isDuplicatePage) {
      results.push(...pageResult.edges.map((edge) => edge.node));
    }

    if (!pageResult.pageInfo.hasNextPage) {
      return results;
    }
    if (stalled) {
      throw new PaginationStallError(page + 1, results.length);
    }
  }
  throw new PaginationCapError(MAX_PAGES, results.length);
}

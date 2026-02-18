import { PaginatedData, PaginationInput } from './types';

const PAGINATION_SIZE = 100;

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

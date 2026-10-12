import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FetchInit,
  FetchUrl,
  boundedFetch,
} from '../../src/util/boundedFetch.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** A fetch that never settles on its own -- only the abort signal ends it. */
function stallingFetch() {
  return vi.fn(
    async (_url: FetchUrl, init?: FetchInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      }),
  );
}

describe('boundedFetch', () => {
  it('aborts a request that never completes', async () => {
    globalThis.fetch = stallingFetch();

    // The whole point: undici applies no total-request deadline, so without
    // this the promise never settles and the caller -- the identity digest,
    // holding the day-claim -- hangs with no error and no retry.
    await expect(
      boundedFetch('https://example.test', undefined, 10),
    ).rejects.toThrow();
  });

  it('passes the caller init through untouched apart from the signal', async () => {
    const spy = vi.fn(
      async (_url: FetchUrl, _init?: FetchInit) => new Response('ok'),
    );
    globalThis.fetch = spy;

    await boundedFetch(
      'https://example.test',
      { method: 'POST', body: 'x' },
      1_000,
    );

    const init = spy.mock.calls[0][1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('x');
    expect(init?.signal).toBeDefined();
  });

  it("honours a caller's own signal alongside the deadline", async () => {
    globalThis.fetch = stallingFetch();
    const controller = new AbortController();

    // graphql-request supplies its own per-request signal; combining rather
    // than replacing means neither cancellation path is silently dropped.
    const pending = boundedFetch(
      'https://example.test',
      { signal: controller.signal },
      60_000,
    );
    controller.abort();

    await expect(pending).rejects.toThrow();
  });

  it('returns the response unchanged when the request completes in time', async () => {
    globalThis.fetch = vi.fn(async () => new Response('body-here'));

    const response = await boundedFetch(
      'https://example.test',
      undefined,
      1_000,
    );

    expect(await response.text()).toBe('body-here');
  });
});

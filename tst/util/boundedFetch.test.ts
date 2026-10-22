import nock from 'nock';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FetchInit,
  FetchUrl,
  boundedFetch,
  fetchBytesCapped,
} from '../../src/util/boundedFetch.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  nock.cleanAll();
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

describe('fetchBytesCapped', () => {
  const HOST = 'https://photos.example.test';
  const CAP = 1000;

  it('returns the body when it is within the cap', async () => {
    nock(HOST).get('/a.webp').reply(200, Buffer.alloc(CAP, 7));
    const bytes = await fetchBytesCapped(`${HOST}/a.webp`, CAP, 1_000);
    expect(bytes).toEqual(Buffer.alloc(CAP, 7));
  });

  it('refuses http', async () => {
    const spy = vi.fn(async () => new Response('x'));
    globalThis.fetch = spy;
    expect(
      await fetchBytesCapped('http://photos.example.test/a', CAP, 1_000),
    ).toBeNull();
    expect(await fetchBytesCapped('not a url', CAP, 1_000)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns null when Content-Length is over the cap', async () => {
    nock(HOST)
      .get('/big.webp')
      .reply(200, Buffer.alloc(CAP + 1), { 'Content-Length': String(CAP + 1) });
    expect(await fetchBytesCapped(`${HOST}/big.webp`, CAP, 1_000)).toBeNull();
  });

  it('cancels a stream that passes the cap without Content-Length', async () => {
    const CHUNK = 256;
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          // Would yield 1 MB if read to the end.
          if (pulled >= 1024 * 1024) {
            controller.close();
            return;
          }
          pulled += CHUNK;
          controller.enqueue(new Uint8Array(CHUNK));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    globalThis.fetch = vi.fn(async () => new Response(body));

    expect(await fetchBytesCapped(`${HOST}/stream`, CAP, 1_000)).toBeNull();
    expect(pulled).toBeLessThanOrEqual(CAP + CHUNK);
    expect(cancelled).toBe(true);
  });

  it('returns null on 404 and on timeout', async () => {
    nock(HOST).get('/missing').reply(404, 'nope');
    expect(await fetchBytesCapped(`${HOST}/missing`, CAP, 1_000)).toBeNull();

    globalThis.fetch = stallingFetch();
    expect(await fetchBytesCapped(`${HOST}/slow`, CAP, 10)).toBeNull();
  });

  it('does not follow a redirect off the host', async () => {
    nock(HOST)
      .get('/moved')
      .reply(302, '', { Location: 'https://elsewhere.example.test/x' });
    const elsewhere = nock('https://elsewhere.example.test')
      .get('/x')
      .reply(200, 'x');
    expect(await fetchBytesCapped(`${HOST}/moved`, CAP, 1_000)).toBeNull();
    expect(elsewhere.isDone()).toBe(false);
  });

  it('never throws, and logs the class name only', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('secret https://photos.example.test/token=abc');
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(
      fetchBytesCapped(`${HOST}/token=abc`, CAP, 1_000),
    ).resolves.toBeNull();
    const printed = log.mock.calls.flat().map(String).join(' ');
    expect(printed).toContain('TypeError');
    expect(printed).not.toContain('token=abc');
    expect(printed).not.toContain('photos.example.test');
  });
});

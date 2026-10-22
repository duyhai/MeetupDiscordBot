import { Logger } from 'tslog';

/**
 * `fetch` with a total-request deadline.
 *
 * Undici imposes no overall deadline of its own: a connection that opens and
 * then stalls mid-body never rejects, so an `await fetch(...)` can hang for
 * the life of the process. Every caller here runs inside the daily identity
 * digest, after the day-claim is taken -- a hang there means no digest, no
 * error, and no retry, because the claim is only released on a throw.
 *
 * This exists as one helper rather than four near-identical inline
 * `AbortSignal.timeout(...)` calls (the Discord CDN thumb fetch, the Meetup
 * thumb fetch, the Meetup token refresh, and the GraphQL roster pages) so
 * that a refactor cannot quietly drop the deadline from one of them.
 *
 * Callers keep their own timeout values: a 5s budget is right for a
 * best-effort thumbnail that degrades to null, and wrong for a token refresh
 * the whole sweep depends on.
 */
// Derived from the ambient `fetch` rather than written as `RequestInfo` /
// `RequestInit`: this project compiles with `lib: ES2022` and no DOM, so
// those names are not in scope even though `fetch` itself is.
export type FetchUrl = Parameters<typeof fetch>[0];
export type FetchInit = Parameters<typeof fetch>[1];

export async function boundedFetch(
  url: FetchUrl,
  init: FetchInit,
  timeoutMs: number,
): Promise<Response> {
  return fetch(url, {
    ...init,
    // A caller-supplied signal is respected in addition to the deadline:
    // graphql-request passes its own per-request signal through `init`.
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
}

const cappedLogger = new Logger({ name: 'boundedFetch' });

/**
 * The body of an https GET, or null: on a non-2xx (redirects are not
 * followed), a `Content-Length` over `maxBytes`, a streamed body passing
 * `maxBytes` (the read is cancelled there, so at most one chunk past the cap
 * is ever buffered), the deadline, or any error. Never throws. Logs the
 * error's class name only: never the URL.
 */
export async function fetchBytesCapped(
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer | null> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:') {
    return null;
  }
  try {
    const response = await boundedFetch(
      target.href,
      { redirect: 'error' },
      timeoutMs,
    );
    const declared = response.headers.get('content-length');
    if (
      !response.ok ||
      response.body === null ||
      (declared !== null && !(Number(declared) <= maxBytes))
    ) {
      response.body?.cancel().catch(() => undefined);
      return null;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    // One chunk at a time, checked as it lands. Leaving the loop early
    // cancels the stream, so nothing past this chunk is read.
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        return null;
      }
      chunks.push(chunk);
    }
    return total === 0 ? null : Buffer.concat(chunks, total);
  } catch (error: unknown) {
    cappedLogger.warn(
      `Capped fetch failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return null;
  }
}

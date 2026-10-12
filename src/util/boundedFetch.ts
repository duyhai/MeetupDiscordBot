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

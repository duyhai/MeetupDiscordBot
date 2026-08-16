/* eslint-disable no-await-in-loop */
import { sleep } from '../../util/sleep.js';

export interface OAuthWaitOptions {
  intervalMs: number;
  timeoutMs: number;
}

export type OAuthWaitResult =
  { rawTokens: string; status: 'ready' } | { status: 'pending' };

/**
 * Polls the cache until the member's Meetup authorization lands.
 *
 * Running out of time is NOT an error: tokens live in the cache for hours, so
 * a member who wanders off mid-authorization only has to try again and the
 * next attempt completes instantly. Returning `pending` keeps that ordinary
 * slowness out of the alerts channel, which is reserved for genuine faults.
 */
export async function waitForMeetupTokens(
  read: (key: string) => Promise<string | undefined>,
  tokenKey: string,
  { intervalMs, timeoutMs }: OAuthWaitOptions,
): Promise<OAuthWaitResult> {
  const startTime = Date.now();

  for (;;) {
    const rawTokens = await read(tokenKey);
    if (rawTokens) {
      return { status: 'ready', rawTokens };
    }
    if (Date.now() - startTime >= timeoutMs) {
      return { status: 'pending' };
    }
    await sleep(intervalMs);
  }
}

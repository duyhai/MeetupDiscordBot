/* eslint-disable no-await-in-loop */
import { sleep } from '../../util/sleep.js';

export type OAuthHop = 'Discord' | 'Meetup';

export interface OAuthTokenKeys {
  discordKey: string;
  meetupKey: string;
}

export interface OAuthWaitOptions {
  intervalMs: number;
  timeoutMs: number;
}

export type OAuthWaitResult =
  | { pendingHop: OAuthHop; status: 'pending' }
  | { rawDiscordTokens: string; rawMeetupTokens: string; status: 'ready' };

/**
 * Polls the cache until both OAuth hops have deposited their tokens.
 *
 * Running out of time is NOT an error: tokens live in the cache for hours, so
 * a member who wanders off mid-authorization only has to press the button
 * again and the next attempt completes instantly. Returning `pending` (with
 * the hop still outstanding, so the reply can name it) keeps that case out of
 * the alerts channel, which is reserved for genuine faults.
 */
export async function waitForOAuthTokens(
  read: (key: string) => Promise<string | undefined>,
  { discordKey, meetupKey }: OAuthTokenKeys,
  { intervalMs, timeoutMs }: OAuthWaitOptions,
): Promise<OAuthWaitResult> {
  const startTime = Date.now();

  for (;;) {
    const rawDiscordTokens = await read(discordKey);
    const rawMeetupTokens = await read(meetupKey);
    if (rawDiscordTokens && rawMeetupTokens) {
      return { status: 'ready', rawDiscordTokens, rawMeetupTokens };
    }
    if (Date.now() - startTime >= timeoutMs) {
      return {
        status: 'pending',
        pendingHop: rawDiscordTokens ? 'Meetup' : 'Discord',
      };
    }
    await sleep(intervalMs);
  }
}

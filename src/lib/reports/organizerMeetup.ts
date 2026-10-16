import { Client } from 'discord.js';

import { BASE_DISCORD_BOT_URL } from '../../constants.js';
import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import {
  getOrganizerAccessToken,
  isMeetupUnauthorized,
} from '../helpers/organizerMeetupClient.js';

export class OrganizerTokenUnavailableError extends Error {
  /** Its text may reach #meetup-bot-alerts. */
  readonly organizerSafeMessage = true;

  constructor() {
    super(
      'No usable Meetup organizer login, so the reports could not be read from Meetup ' +
        `(see the organizer login alert). Renew it at ${BASE_DISCORD_BOT_URL}/dashboard/organizer-login.`,
    );
    this.name = 'OrganizerTokenUnavailableError';
  }
}

export interface OrganizerMeetupDeps {
  getToken: typeof getOrganizerAccessToken;
  makeClient: (accessToken: string) => GqlMeetupClient;
}

export const defaultOrganizerMeetupDeps: OrganizerMeetupDeps = {
  getToken: getOrganizerAccessToken,
  makeClient: (accessToken) =>
    new GqlMeetupClient(accessToken, { bypassCache: true }),
};

/**
 * Runs fn with a Meetup client on the shared organizer credential. The token
 * comes only from getOrganizerAccessToken, which refreshes under the
 * cross-process lock and alerts once per failure episode itself. A 401 gets
 * one forced refresh (naming the refused token, so a token another process
 * already rotated is reused) and one retry, as runMeetupSweep does; a second
 * failure propagates.
 */
export async function withOrganizerMeetup<T>(
  client: Client | undefined,
  fn: (meetup: GqlMeetupClient) => Promise<T>,
  deps: OrganizerMeetupDeps = defaultOrganizerMeetupDeps,
): Promise<T> {
  const accessToken = await deps.getToken({ client });
  if (!accessToken) {
    throw new OrganizerTokenUnavailableError();
  }
  try {
    return await fn(deps.makeClient(accessToken));
  } catch (error: unknown) {
    if (!isMeetupUnauthorized(error)) {
      throw error;
    }
    const retryToken = await deps.getToken({
      forceRefresh: true,
      refusedAccessToken: accessToken,
      client,
    });
    if (!retryToken) {
      throw new OrganizerTokenUnavailableError();
    }
    return fn(deps.makeClient(retryToken));
  }
}

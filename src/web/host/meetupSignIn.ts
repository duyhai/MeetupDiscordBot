import crypto from 'crypto';
import { OAuth2Client } from 'arctic';

import Configuration from '../../configuration.js';
import { BASIC_MEETUP_AUTH_SCOPES } from '../../constants.js';
import { meetupRedirectUri } from '../../lib/client/oauth/providers.js';
import { boundedFetch } from '../../util/boundedFetch.js';

const MEETUP_AUTHORIZE_ENDPOINT = 'https://secure.meetup.com/oauth2/authorize';
const SELF_TIMEOUT_MS = 10_000;
const MEETUP_ID = /^[1-9][0-9]{0,19}$/;

/**
 * A host dashboard Meetup sign-in shares the app's one registered Meetup
 * redirect URI (/connect/meetup/callback). Its state starts with this
 * prefix, so that callback can hand it to the host router without the Redis
 * state lookup member links use: a signed-out visitor never writes to Redis.
 */
export const HOST_STATE_PREFIX = 'host-';
export const HOST_MEETUP_COMPLETE_PATH = '/host/auth/meetup/complete';

const HOST_STATE = /^host-[A-Za-z0-9_-]{32,64}$/;

export function newHostState(): string {
  return `${HOST_STATE_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

export function isHostState(state: unknown): state is string {
  return typeof state === 'string' && HOST_STATE.test(state);
}

/** Same client, scope and redirect URI as the member-link flow. */
export function buildHostMeetupAuthUrl(state: string): string {
  const client = new OAuth2Client(
    Configuration.meetup.apiKey,
    Configuration.meetup.apiSecret,
    meetupRedirectUri(),
  );
  return client
    .createAuthorizationURL(
      MEETUP_AUTHORIZE_ENDPOINT,
      state,
      BASIC_MEETUP_AUTH_SCOPES,
    )
    .toString();
}

/**
 * Who signed in: the member's own token is used for this one query and then
 * dropped (never stored; every Meetup action uses the organizer
 * credential). Errors carry the HTTP status only, never a body.
 */
export async function fetchMeetupSelf(
  accessToken: string,
): Promise<{ id: string; name: string }> {
  const response = await boundedFetch(
    Configuration.meetup.endpoint,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: 'query { self { id name } }' }),
    },
    SELF_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`Meetup self lookup failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    data?: { self?: { id?: unknown; name?: unknown } | null };
  };
  const self = body.data?.self;
  const id = typeof self?.id === 'string' ? self.id : String(self?.id ?? '');
  if (!MEETUP_ID.test(id)) {
    throw new Error('Meetup self lookup returned no usable id');
  }
  const name =
    typeof self?.name === 'string' && self.name.trim() ? self.name : id;
  return { id, name };
}

import { OAuth2Client } from 'arctic';

import Configuration from '../../../configuration.js';
import {
  BASE_DISCORD_BOT_URL,
  BASIC_MEETUP_AUTH_SCOPES,
  debugRedirect,
} from '../../../constants.js';
import { boundedFetch } from '../../../util/boundedFetch.js';
import { APIAccessTokenResponse, Tokens } from '../discord/types.js';

const MEETUP_AUTHORIZE_ENDPOINT = 'https://secure.meetup.com/oauth2/authorize';
const MEETUP_TOKEN_ENDPOINT = 'https://secure.meetup.com/oauth2/access';

// The refresh runs inside the daily digest, after the day-claim is taken, so
// an unbounded POST to a stalled endpoint hangs the digest holding the claim.
// Longer than the 5s thumbnail budget because a failure here is not
// best-effort: it takes the whole Meetup sweep down.
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Meetup's `expires_in` is documented as seconds, but a malformed or absent
 * value would otherwise produce `NaN` here -- and `new Date(NaN)` is what
 * eventually reaches the credential row, so the stored pair becomes
 * unreadable and every later sweep re-seeds from the config var. One hour is
 * Meetup's own documented lifetime and the safe assumption.
 */
function expiresAtFrom(expiresIn: unknown): number {
  const seconds = Number.isFinite(expiresIn) ? (expiresIn as number) : 3600;
  return Date.now() + seconds * 1000;
}

/**
 * Meetup answered a token request with 2xx but no usable access token. Not
 * a rejection of the grant -- it says nothing about whether the refresh
 * token is dead -- so it never sends the caller to the config seed. Fixed
 * message: the body is never carried.
 */
export class MeetupTokenResponseError extends Error {
  constructor() {
    super('Meetup token response had no usable access token');
    this.name = 'MeetupTokenResponseError';
  }
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** The access token of a 2xx token response, or MeetupTokenResponseError. */
function accessTokenFrom(raw: APIAccessTokenResponse): string {
  const accessToken: unknown = raw?.access_token;
  if (!isNonEmptyString(accessToken)) {
    throw new MeetupTokenResponseError();
  }
  return accessToken;
}

// Registered with the providers; must be byte-identical in the authorize URL
// and the token exchange. debugRedirect keeps local dev working through the
// production /redirect trampoline.
const meetupRedirectUri = () =>
  debugRedirect(`${BASE_DISCORD_BOT_URL}/connect/meetup/callback`);

export function buildMeetupAuthUrl(state: string): string {
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

// Hand-rolled: Meetup's token endpoint expects client credentials in the
// form body (the old grant flow sent them that way); arctic's generic client
// would send HTTP Basic instead.
export async function exchangeMeetupCode(code: string): Promise<Tokens> {
  const body = new URLSearchParams({
    client_id: Configuration.meetup.apiKey,
    client_secret: Configuration.meetup.apiSecret,
    grant_type: 'authorization_code',
    redirect_uri: meetupRedirectUri(),
    code,
  });
  const response = await boundedFetch(
    MEETUP_TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    TOKEN_REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(
      `Meetup token exchange failed: [${response.status}] ${await response.text()}`,
    );
  }
  const raw = (await response.json()) as APIAccessTokenResponse;
  return {
    accessToken: accessTokenFrom(raw),
    refreshToken: raw.refresh_token,
    expiresAt: expiresAtFrom(raw.expires_in),
  };
}

/**
 * The OAuth `error` code from a token-endpoint error body (RFC 6749 §5.2),
 * e.g. `invalid_grant`. Only a short code-shaped value is accepted: this is
 * the one part of the body callers may log, and the rest of it is untrusted
 * and may echo the credentials that were sent.
 */
function oauthErrorCodeFrom(body: string): string | undefined {
  try {
    const { error } = JSON.parse(body) as { error?: unknown };
    return typeof error === 'string' && /^[a-z_]{1,40}$/.test(error)
      ? error
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Meetup answered a refresh request with a non-2xx status. `status` and
 * `oauthError` are there so callers can tell a dead grant (`invalid_grant`)
 * from a problem with our own client credentials (`invalid_client`) or an
 * outage without parsing the message -- which embeds Meetup's raw response
 * body and is not safe to log anywhere a member or a Discord channel can
 * read it.
 */
export class MeetupTokenRefreshError extends Error {
  readonly oauthError: string | undefined;

  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Meetup token refresh failed: [${status}] ${body}`);
    this.name = 'MeetupTokenRefreshError';
    this.oauthError = oauthErrorCodeFrom(body);
  }
}

/**
 * Exchanges a refresh token for a fresh access token. Meetup access tokens
 * expire after an hour, so anything that must run on a schedule -- the daily
 * Meetup sweep -- needs this rather than a stored access token.
 */
export async function refreshMeetupToken(
  refreshToken: string,
): Promise<Tokens> {
  const body = new URLSearchParams({
    client_id: Configuration.meetup.apiKey,
    client_secret: Configuration.meetup.apiSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const response = await boundedFetch(
    MEETUP_TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    TOKEN_REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new MeetupTokenRefreshError(response.status, await response.text());
  }
  const raw = (await response.json()) as APIAccessTokenResponse;
  const accessToken = accessTokenFrom(raw);
  const returnedRefreshToken: unknown = raw?.refresh_token;
  return {
    accessToken,
    // Providers differ on whether refresh tokens rotate. Carry back whatever
    // arrived so the caller can persist it; fall back to the one we sent
    // when none (or an empty or non-string one) came back.
    refreshToken: isNonEmptyString(returnedRefreshToken)
      ? returnedRefreshToken
      : refreshToken,
    expiresAt: expiresAtFrom(raw.expires_in),
  };
}

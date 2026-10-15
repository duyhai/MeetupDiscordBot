// src/web/discordOAuth.ts
import { Discord } from 'arctic';

import Configuration from '../configuration.js';
import { BASE_DISCORD_BOT_URL } from '../constants.js';
import { boundedFetch } from '../util/boundedFetch.js';

const IDENTITY_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 10_000;
const DISCORD_TOKEN_ENDPOINT = 'https://discord.com/api/oauth2/token';
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Registered in the Discord developer portal by Hai. Not routed through
 * debugRedirect: local testing registers its own localhost URI instead, so
 * the session cookie is set on the host that will read it.
 */
export const dashboardRedirectUri = () =>
  `${BASE_DISCORD_BOT_URL}/dashboard/auth/callback`;

const provider = () =>
  new Discord(
    Configuration.discord.oauthClientId,
    Configuration.discord.oauthSecret,
    dashboardRedirectUri(),
  );

export function buildDashboardLoginUrl(
  state: string,
  codeVerifier: string,
): string {
  return provider()
    .createAuthorizationURL(state, codeVerifier, ['identify'])
    .toString();
}

/**
 * Hand-rolled instead of arctic's validateAuthorizationCode: that call uses
 * bare fetch with no deadline, so a stalled connection would hang the
 * sign-in callback. The access token is used once, for /users/@me, and never
 * stored.
 */
export async function exchangeDashboardCode(
  code: string,
  codeVerifier: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: Configuration.discord.oauthClientId,
    client_secret: Configuration.discord.oauthSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: dashboardRedirectUri(),
    code_verifier: codeVerifier,
  });
  const response = await boundedFetch(
    DISCORD_TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    TOKEN_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`Discord token exchange failed: ${response.status}`);
  }
  const raw = (await response.json()) as { access_token?: unknown };
  if (typeof raw.access_token !== 'string' || !raw.access_token) {
    throw new Error('Discord token exchange returned no access token');
  }
  return raw.access_token;
}

export async function fetchDiscordIdentity(
  accessToken: string,
): Promise<{ id: string; username: string }> {
  const response = await boundedFetch(
    'https://discord.com/api/v10/users/@me',
    { headers: { Authorization: `Bearer ${accessToken}` } },
    IDENTITY_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`Discord identity lookup failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    global_name?: unknown;
    id?: unknown;
    username?: unknown;
  };
  if (typeof body.id !== 'string' || !SNOWFLAKE.test(body.id)) {
    throw new Error('Discord identity lookup returned no usable id');
  }
  const shown =
    typeof body.global_name === 'string' && body.global_name
      ? body.global_name
      : typeof body.username === 'string'
        ? body.username
        : body.id;
  return { id: body.id, username: shown };
}

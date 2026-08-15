import { Discord, OAuth2Client, OAuth2Tokens } from 'arctic';
import { OAuth2Scopes } from 'discord.js';

import Configuration from '../../../configuration.js';
import {
  BASE_DISCORD_BOT_URL,
  BASIC_MEETUP_AUTH_SCOPES,
  debugRedirect,
} from '../../../constants.js';
import { APIAccessTokenResponse, Tokens } from '../discord/types.js';

const MEETUP_AUTHORIZE_ENDPOINT = 'https://secure.meetup.com/oauth2/authorize';
const MEETUP_TOKEN_ENDPOINT = 'https://secure.meetup.com/oauth2/access';
const DISCORD_PROFILE_ENDPOINT = 'https://discord.com/api/v10/users/@me';

// Registered with the providers; must be byte-identical in the authorize URL
// and the token exchange. debugRedirect keeps local dev working through the
// production /redirect trampoline.
const discordRedirectUri = () =>
  debugRedirect(`${BASE_DISCORD_BOT_URL}/connect/discord/callback`);
const meetupRedirectUri = () =>
  debugRedirect(`${BASE_DISCORD_BOT_URL}/connect/meetup/callback`);

function toTokens(tokens: OAuth2Tokens): Tokens {
  return {
    accessToken: tokens.accessToken(),
    refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : '',
    expiresAt: tokens.accessTokenExpiresAt().getTime(),
  };
}

const discordProvider = () =>
  new Discord(
    Configuration.discord.oauthClientId,
    Configuration.discord.oauthSecret,
    discordRedirectUri(),
  );

export function buildDiscordAuthUrl(state: string): string {
  const url = discordProvider().createAuthorizationURL(state, null, [
    OAuth2Scopes.Identify,
    OAuth2Scopes.RoleConnectionsWrite,
  ]);
  // Returning users who already granted these scopes skip the consent screen.
  url.searchParams.set('prompt', 'none');
  return url.toString();
}

export async function exchangeDiscordCode(code: string): Promise<Tokens> {
  return toTokens(
    await discordProvider().validateAuthorizationCode(code, null),
  );
}

export async function fetchDiscordUserId(accessToken: string): Promise<string> {
  const response = await fetch(DISCORD_PROFILE_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `Discord profile fetch failed: [${response.status}] ${await response.text()}`,
    );
  }
  const profile = (await response.json()) as { id: string };
  return profile.id;
}

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
  const response = await fetch(MEETUP_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `Meetup token exchange failed: [${response.status}] ${await response.text()}`,
    );
  }
  const raw = (await response.json()) as APIAccessTokenResponse;
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: Date.now() + raw.expires_in * 1000,
  };
}

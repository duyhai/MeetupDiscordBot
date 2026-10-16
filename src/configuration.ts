import { Logger } from 'tslog';

interface ConfigurationSchema {
  discord: {
    apiKey: string;
    oauthClientId: string;
    oauthSecret: string;
  };
  meetup: {
    apiKey: string;
    apiSecret: string;
    endpoint: string;
    groupId: string;
    groupUrlName: string;
    organizerRefreshToken: string | undefined;
    organizerMemberId: string | undefined;
  };
}

const ORGANIZER_MEMBER_ID_PATTERN = /^\d{1,20}$/;

/**
 * MEETUP_ORGANIZER_MEMBER_ID, trimmed; undefined when unset, blank or not
 * 1-20 digits. A malformed value warns once, by name only (never the value),
 * and counts as unset rather than becoming an account no token can match.
 */
export function organizerMemberIdFrom(
  raw: string | undefined,
  warn: (message: string) => void = (message) =>
    new Logger({ name: 'configuration' }).warn(message),
): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if (!ORGANIZER_MEMBER_ID_PATTERN.test(value)) {
    warn(
      'MEETUP_ORGANIZER_MEMBER_ID is not a Meetup member id (1-20 digits); ignoring it',
    );
    return undefined;
  }
  return value;
}

const Configuration: ConfigurationSchema = {
  discord: {
    apiKey: process.env.DISCORD_API_KEY,
    oauthClientId: process.env.DISCORD_CLIENT_ID,
    oauthSecret: process.env.DISCORD_SECRET,
  },
  meetup: {
    apiKey: process.env.MEETUP_KEY,
    apiSecret: process.env.MEETUP_SECRET,
    endpoint: 'https://api.meetup.com/gql-ext',
    groupId: '7595882',
    groupUrlName: '1-5genasians',
    // Deliberately absent from REQUIRED_VARS: the bot must still start
    // without it, with only Meetup-side identity monitoring disabled.
    organizerRefreshToken: process.env.MEETUP_ORGANIZER_REFRESH_TOKEN,
    // The shared organizer account's Meetup member id: the bootstrap check
    // for organizer renewal until one is stored. Optional, like the token.
    organizerMemberId: organizerMemberIdFrom(
      process.env.MEETUP_ORGANIZER_MEMBER_ID,
    ),
  },
};

const REQUIRED_VARS = [
  'DISCORD_API_KEY',
  'DISCORD_CLIENT_ID',
  'DISCORD_SECRET',
  'MEETUP_KEY',
  'MEETUP_SECRET',
];

/**
 * Fails the boot instead of letting a missing credential surface later as a
 * confusing provider error (arctic will happily build an authorize URL with
 * `client_id=undefined`). REDISCLOUD_URL is required outside local dev
 * because the in-memory cache fallback is per-process: OAuth state written
 * on one dyno is invisible to the callback that lands on another, so every
 * flow fails — silently.
 */
export function assertRequiredConfiguration(
  env: Record<string, string | undefined> = process.env,
): void {
  const required = env.TS_NODE_DEBUG
    ? REQUIRED_VARS
    : [...REQUIRED_VARS, 'REDISCLOUD_URL'];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }
}

export default Configuration;

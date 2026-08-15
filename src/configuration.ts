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
  };
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

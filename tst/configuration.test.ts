import { describe, expect, it } from 'vitest';

import { assertRequiredConfiguration } from '../src/configuration.js';

const completeEnv = {
  DISCORD_API_KEY: 'k',
  DISCORD_CLIENT_ID: 'id',
  DISCORD_SECRET: 's',
  MEETUP_KEY: 'mk',
  MEETUP_SECRET: 'ms',
  REDISCLOUD_URL: 'redis://localhost:6379',
};

describe('assertRequiredConfiguration', () => {
  it('passes when everything is set', () => {
    expect(() => assertRequiredConfiguration(completeEnv)).not.toThrow();
  });

  it('names every missing variable rather than failing on the first', () => {
    const { DISCORD_SECRET: _s, MEETUP_KEY: _k, ...rest } = completeEnv;

    expect(() => assertRequiredConfiguration(rest)).toThrow(
      /DISCORD_SECRET.*MEETUP_KEY|MEETUP_KEY.*DISCORD_SECRET/s,
    );
  });

  it('requires REDISCLOUD_URL in production, where the in-memory fallback breaks OAuth', () => {
    const { REDISCLOUD_URL: _r, ...withoutRedis } = completeEnv;

    expect(() => assertRequiredConfiguration(withoutRedis)).toThrow(
      /REDISCLOUD_URL/,
    );
  });

  it('allows a missing REDISCLOUD_URL in local dev', () => {
    const { REDISCLOUD_URL: _r, ...withoutRedis } = completeEnv;

    expect(() =>
      assertRequiredConfiguration({ ...withoutRedis, TS_NODE_DEBUG: 'true' }),
    ).not.toThrow();
  });
});

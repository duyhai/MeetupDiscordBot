import { describe, expect, it, vi } from 'vitest';

import {
  assertRequiredConfiguration,
  organizerMemberIdFrom,
} from '../src/configuration.js';

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

describe('organizerMemberIdFrom (MEETUP_ORGANIZER_MEMBER_ID)', () => {
  it('trims whitespace', () => {
    const warn = vi.fn();
    expect(organizerMemberIdFrom(' 468174923\n', warn)).toBe('468174923');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['letters', '46817abc'],
    ['a sign', '-468174923'],
    ['an inner space', '468 174923'],
    ['more than 20 digits', '1'.repeat(21)],
  ])(
    'rejects a value with %s: warns by name only, and leaves it unset',
    (_n, raw) => {
      const warn = vi.fn();

      expect(organizerMemberIdFrom(raw, warn)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0] as [string];
      expect(message).toContain('MEETUP_ORGANIZER_MEMBER_ID');
      expect(message).not.toContain(raw.trim());
    },
  );

  it.each([
    ['an empty value', ''],
    ['a blank value', '   '],
    ['an absent value', undefined],
  ])('treats %s as unset, without a warning', (_n, raw) => {
    const warn = vi.fn();
    expect(organizerMemberIdFrom(raw, warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

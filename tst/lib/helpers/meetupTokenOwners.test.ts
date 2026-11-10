import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KeyValueCache } from '../../../src/lib/cache/base.js';
import {
  MeetupTokenRefreshError,
  refreshMeetupToken,
} from '../../../src/lib/client/oauth/providers.js';
import {
  MEETUP_TOKEN_TTL_SEC,
  forgetMeetupTokens,
  getUsableMeetupTokens,
  meetupTokenKey,
  moveMeetupTokens,
  storeMeetupTokens,
} from '../../../src/lib/helpers/meetupTokens.js';

vi.mock(
  '../../../src/lib/client/oauth/providers.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../src/lib/client/oauth/providers.js')
    >()),
    refreshMeetupToken: vi.fn(),
  }),
);

function memoryCache() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const cache = {
    get: async (key: string) => data.get(key),
    set: async (key: string, value: string, ttl?: number) => {
      data.set(key, value);
      ttls.set(key, ttl);
    },
    remove: async (key: string) => {
      data.delete(key);
    },
  } as unknown as KeyValueCache;
  return { cache, data, ttls };
}

const HOUR = 60 * 60 * 1000;
const fresh = {
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: Date.now() + HOUR,
};

describe('Meetup token owners', () => {
  beforeEach(() => {
    vi.mocked(refreshMeetupToken).mockReset();
  });

  it('keeps the bot’s keys byte for byte: a Discord id is the key it always was', () => {
    expect(meetupTokenKey('123456789012345678')).toBe(
      '123456789012345678-meetup-tokens',
    );
    // A host sign-in with no Discord link has its own key shape.
    expect(meetupTokenKey({ meetup: '4242' })).toBe(
      'meetup:4242-meetup-tokens',
    );
  });

  it('stores, reads and forgets a Meetup-keyed set with the same 30-day TTL', async () => {
    const { cache, ttls } = memoryCache();
    await storeMeetupTokens(cache, { meetup: '4242' }, fresh);
    expect(ttls.get('meetup:4242-meetup-tokens')).toBe(MEETUP_TOKEN_TTL_SEC);
    expect(await getUsableMeetupTokens(cache, { meetup: '4242' })).toEqual(
      fresh,
    );
    await forgetMeetupTokens(cache, { meetup: '4242' });
    expect(
      await getUsableMeetupTokens(cache, { meetup: '4242' }),
    ).toBeUndefined();
  });

  it('moves a set to the Discord key on linking, replacing what was there', async () => {
    const { cache, data, ttls } = memoryCache();
    await storeMeetupTokens(cache, '123456789012345678', {
      ...fresh,
      accessToken: 'old',
    });
    await storeMeetupTokens(cache, { meetup: '4242' }, fresh);
    await moveMeetupTokens(cache, { meetup: '4242' }, '123456789012345678');
    expect(data.has('meetup:4242-meetup-tokens')).toBe(false);
    expect(
      JSON.parse(data.get('123456789012345678-meetup-tokens') ?? '{}'),
    ).toEqual(fresh);
    expect(ttls.get('123456789012345678-meetup-tokens')).toBe(
      MEETUP_TOKEN_TTL_SEC,
    );
    // Nothing to move: nothing changes.
    await moveMeetupTokens(cache, { meetup: '9999' }, '123456789012345678');
    expect(data.size).toBe(1);
  });

  it('refreshes an expired Meetup-keyed set silently, under its own key', async () => {
    const { cache, data } = memoryCache();
    await storeMeetupTokens(
      cache,
      { meetup: '4242' },
      {
        ...fresh,
        expiresAt: Date.now() - HOUR,
      },
    );
    vi.mocked(refreshMeetupToken).mockResolvedValue({
      accessToken: 'new',
      refreshToken: 'r2',
      expiresAt: Date.now() + HOUR,
    });
    expect(
      (await getUsableMeetupTokens(cache, { meetup: '4242' }))?.accessToken,
    ).toBe('new');
    expect(
      JSON.parse(data.get('meetup:4242-meetup-tokens') ?? '{}'),
    ).toMatchObject({
      accessToken: 'new',
    });
  });

  it('a rejected refresh leaves nothing usable', async () => {
    const { cache } = memoryCache();
    await storeMeetupTokens(
      cache,
      { meetup: '4242' },
      {
        ...fresh,
        expiresAt: Date.now() - HOUR,
      },
    );
    vi.mocked(refreshMeetupToken).mockRejectedValue(
      new MeetupTokenRefreshError(400, '{"error":"invalid_grant"}'),
    );
    expect(
      await getUsableMeetupTokens(cache, { meetup: '4242' }),
    ).toBeUndefined();
  });
});

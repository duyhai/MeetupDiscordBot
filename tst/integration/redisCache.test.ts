import crypto from 'crypto';

import { RedisCache } from '../../src/lib/cache/redisCache.js';

// Exercises RedisCache against a real Redis instance rather than mocking the
// `redis` package -- TTL/NX behavior is exactly what a mock would paper
// over. Requires REDISCLOUD_URL to point at a reachable Redis (the CI
// "integration" job provides one via a service container); skipped
// otherwise so `yarn test:integration` doesn't hard-fail for anyone running
// it without a local Redis.
const REDIS_AVAILABLE = Boolean(process.env.REDISCLOUD_URL);

if (!REDIS_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping RedisCache integration tests: set REDISCLOUD_URL to a reachable Redis to run them.'
  );
}

(REDIS_AVAILABLE ? describe : describe.skip)('RedisCache (integration)', () => {
  let cache: RedisCache;

  beforeAll(async () => {
    cache = await RedisCache.instance();
  });

  it('returns undefined for a key that was never set', async () => {
    expect(
      await cache.get(`missing-key-${crypto.randomUUID()}`)
    ).toBeUndefined();
  });

  it('round-trips a value through set/get', async () => {
    const key = `roundtrip-${crypto.randomUUID()}`;
    await cache.set(key, 'hello world');

    expect(await cache.get(key)).toBe('hello world');
  });

  it('remove deletes a previously stored value', async () => {
    const key = `remove-${crypto.randomUUID()}`;
    await cache.set(key, 'to be removed');
    await cache.remove(key);

    expect(await cache.get(key)).toBeUndefined();
  });

  it('exclusive_set only succeeds the first time for a given key', async () => {
    const key = `exclusive-${crypto.randomUUID()}`;

    expect(await cache.exclusive_set(key, 'first')).toBe(true);
    expect(await cache.exclusive_set(key, 'second')).toBe(false);
    // exclusive_set must not overwrite the existing value on failure
    expect(await cache.get(key)).toBe('first');
  });
});

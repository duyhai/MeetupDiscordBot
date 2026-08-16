/* eslint-disable no-console */
import * as redis from 'redis';
import { beforeAll } from 'vitest';

/**
 * Gives every integration file a cold cache.
 *
 * All integration files share one Redis (and one RedisCache singleton) for the
 * duration of a run, so a cached value written by one file satisfies another
 * file's request and the request never reaches the wire. Tests that assert on
 * network traffic then fail depending on which file ran first -- which is
 * exactly how a badge test passed locally, on the in-memory cache, and failed
 * in CI. Several tests also assume a cold cache outright ("only hits the
 * network once"), and pass today only because CI hands each job a brand new
 * container.
 *
 * vitest runs setupFiles once per test file, so flushing here restores that
 * assumption for every file rather than only the first.
 *
 * The flush is destructive, so it is refused for anything that is not clearly
 * a local throwaway instance: pointing REDISCLOUD_URL at a shared or
 * production Redis and running the suite must never wipe live OAuth tokens.
 */
const url = process.env.REDISCLOUD_URL;
const isDisposable = Boolean(url) && /localhost|127\.0\.0\.1|::1/.test(url);

beforeAll(async () => {
  if (!url) {
    // No Redis configured: the in-memory cache is per worker process, so
    // files are already isolated from one another.
    return;
  }
  if (!isDisposable) {
    console.warn(
      `Not flushing ${url.replace(/\/\/.*@/, '//***@')} between test files: ` +
        'it does not look like a local throwaway Redis. Tests that assert on ' +
        'network traffic may fail depending on file order.',
    );
    return;
  }
  const client = redis.createClient({ url });
  await client.connect();
  await client.flushDb();
  await client.quit();
});

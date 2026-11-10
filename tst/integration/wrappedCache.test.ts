import crypto from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { RedisCache } from '../../src/lib/cache/redisCache.js';
import {
  CachedWrapped,
  readWrapped,
  writeWrapped,
} from '../../src/lib/wrapped/cache.js';

// Same gate as redisCache.test.ts: a real Redis is what makes this worth
// running (TTL and JSON round-trip through the actual client).
const REDIS_AVAILABLE = Boolean(process.env.REDISCLOUD_URL);

if (!REDIS_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping Wrapped cache integration tests: set REDISCLOUD_URL to a reachable Redis to run them.',
  );
}

const wrapped: CachedWrapped = {
  meetupId: 'm1',
  stats: {
    year: 2026,
    firstEvent: {
      id: 'e1',
      title: 'Hike',
      dateTime: '2024-03-02T10:00:00-08:00',
      eventUrl: 'https://www.meetup.com/e/e1/',
    },
    attendedThisYear: 12,
    attendedAllTime: 40,
    topTypes: [{ type: 'food', count: 5 }],
    hosting: { thisYear: 1, allTime: 3 },
    busiestMonth: { month: 6, count: 4 },
    longestStreakMonths: 5,
  },
  companions: {
    named: [{ discordUserId: 'd2', sharedCount: 4 }],
    otherCount: 9,
  },
  builtAt: '2026-12-10T20:00:00.000Z',
};

(REDIS_AVAILABLE ? describe : describe.skip)(
  'Wrapped cache (integration)',
  () => {
    let cache: RedisCache;

    beforeAll(async () => {
      cache = await RedisCache.instance();
    });

    it('round-trips a Wrapped through Redis and replaces it on rebuild', async () => {
      const userId = `wrapped-${crypto.randomUUID()}`;

      expect(await readWrapped(cache, userId, 2026)).toBeUndefined();

      await writeWrapped(cache, userId, 2026, wrapped);
      expect(await readWrapped(cache, userId, 2026, 'm1')).toEqual(wrapped);

      const rebuilt = { ...wrapped, builtAt: '2026-12-11T20:00:00.000Z' };
      await writeWrapped(cache, userId, 2026, rebuilt);
      expect(await readWrapped(cache, userId, 2026, 'm1')).toEqual(rebuilt);
      // A different year is a different Wrapped.
      expect(await readWrapped(cache, userId, 2025)).toBeUndefined();
    });
  },
);

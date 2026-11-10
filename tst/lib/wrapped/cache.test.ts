import { describe, expect, it } from 'vitest';

import { KeyValueCache } from '../../../src/lib/cache/base.js';
import {
  BUILD_WINDOW_MS,
  CachedWrapped,
  PAST_YEAR_TTL_SEC,
  createBuildLimiter,
  readWrapped,
  shareGuardKey,
  wrappedCacheKey,
  wrappedTtlSec,
  writeWrapped,
} from '../../../src/lib/wrapped/cache.js';

class FakeCache implements KeyValueCache {
  readonly data = new Map<string, string>();

  readonly ttls = new Map<string, number | undefined>();

  async get(key: string) {
    return this.data.get(key);
  }

  async set(key: string, value: string, ttlSec?: number) {
    this.data.set(key, value);
    this.ttls.set(key, ttlSec);
  }

  async remove(key: string) {
    this.data.delete(key);
  }

  async exclusive_set(key: string, value: string, ttlSec?: number) {
    if (this.data.has(key)) {
      return false;
    }
    await this.set(key, value, ttlSec);
    return true;
  }

  async set_existing(key: string, value: string, ttlSec?: number) {
    if (!this.data.has(key)) {
      return false;
    }
    await this.set(key, value, ttlSec);
    return true;
  }
}

const wrapped: CachedWrapped = {
  meetupId: 'm1',
  stats: {
    year: 2026,
    firstEvent: null,
    attendedThisYear: 0,
    attendedAllTime: 0,
    topTypes: [],
    hosting: null,
    busiestMonth: null,
    longestStreakMonths: 0,
    activeYears: [],
  },
  companions: { named: [], otherCount: 0 },
  builtAt: '2026-12-10T20:00:00.000Z',
};

describe('cache keys', () => {
  it('versions the Wrapped key and scopes the share guard to a channel', () => {
    expect(wrappedCacheKey('d1', 2026)).toBe('wrapped:v3:d1:2026');
    expect(shareGuardKey('d1', 2026, 'c9')).toBe('wrapped:shared:d1:2026:c9');
  });
});

describe('wrappedTtlSec', () => {
  it('keeps the current year until 1 February of the next year, Pacific time', () => {
    const now = new Date('2026-12-10T20:00:00Z');
    const feb1 = new Date('2027-02-01T08:00:00Z');

    expect(wrappedTtlSec(2026, now)).toBe(
      (feb1.getTime() - now.getTime()) / 1000,
    );
  });

  it('keeps a past year for a year: its data is final', () => {
    expect(wrappedTtlSec(2022, new Date('2026-12-10T20:00:00Z'))).toBe(
      PAST_YEAR_TTL_SEC,
    );
    expect(PAST_YEAR_TTL_SEC).toBe(365 * 86400);
    // In January the year just ended is a past year too.
    expect(wrappedTtlSec(2026, new Date('2027-01-15T20:00:00Z'))).toBe(
      PAST_YEAR_TTL_SEC,
    );
  });

  it('keeps the new current year until its own 1 February', () => {
    const now = new Date('2027-01-15T20:00:00Z');
    const feb1 = new Date('2028-02-01T08:00:00Z');

    expect(wrappedTtlSec(2027, now)).toBe(
      (feb1.getTime() - now.getTime()) / 1000,
    );
  });
});

describe('readWrapped / writeWrapped', () => {
  it('round-trips with the season TTL', async () => {
    const cache = new FakeCache();
    const now = new Date('2026-12-10T20:00:00Z');

    await writeWrapped(cache, 'd1', 2026, wrapped, now);

    expect(await readWrapped(cache, 'd1', 2026, 'm1')).toEqual(wrapped);
    expect(cache.ttls.get('wrapped:v3:d1:2026')).toBe(wrappedTtlSec(2026, now));
  });

  it('is a miss when the member has since linked a different Meetup account', async () => {
    const cache = new FakeCache();
    await writeWrapped(cache, 'd1', 2026, wrapped);

    expect(await readWrapped(cache, 'd1', 2026, 'm2')).toBeUndefined();
  });

  it('is undefined when missing or unparseable', async () => {
    const cache = new FakeCache();

    expect(await readWrapped(cache, 'd1', 2026)).toBeUndefined();
    cache.data.set('wrapped:v3:d1:2026', 'not json');
    expect(await readWrapped(cache, 'd1', 2026)).toBeUndefined();
  });
});

describe('createBuildLimiter', () => {
  it('allows one build an hour per member', () => {
    let clock = 0;
    const limiter = createBuildLimiter(() => clock);

    expect(limiter.take('d1')).toBe(true);
    expect(limiter.take('d1')).toBe(false);
    expect(limiter.take('d2')).toBe(true);
    clock += BUILD_WINDOW_MS;
    expect(limiter.take('d1')).toBe(true);
    expect(BUILD_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});

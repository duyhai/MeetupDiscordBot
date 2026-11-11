/**
 * Where a built Wrapped lives, in two tiers: Postgres (wrapped_entries) is
 * the durable store for every year; Redis keeps only the current year as a
 * one-day hot copy. Past years are read from Postgres and never written to
 * Redis (the 30 MB plan is shared with sessions, tokens and the request
 * cache). Without Postgres (no DATABASE_URL) the Redis tier alone behaves as
 * it did before: the season TTL from cache.ts.
 *
 * The relink guard (#138) holds in both tiers: an entry built for a Meetup
 * account other than the member's current link is a miss.
 */
import dayjs from 'dayjs';
import { Logger } from 'tslog';

import { KeyValueCache } from '../cache/base.js';
import { WrappedEntryStore } from '../repositories/postgresWrappedEntryRepository.js';
import { tz } from '../../util/timezone.js';
import {
  CachedWrapped,
  readWrapped,
  wrappedCacheKey,
  writeWrapped,
} from './cache.js';

const logger = new Logger({ name: 'wrappedStore' });

/** The Redis hot copy of the current year. */
export const HOT_TTL_SEC = 24 * 60 * 60;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

export interface WrappedTiers {
  cache: KeyValueCache;
  /** Absent without DATABASE_URL: Redis only. */
  entries?: WrappedEntryStore;
}

const isCurrentYear = (year: number, now: Date) =>
  year === tz(dayjs(now)).year();

export async function readEntry(
  tiers: WrappedTiers,
  discordUserId: string,
  year: number,
  meetupId: string,
  now: Date,
): Promise<CachedWrapped | undefined> {
  const hot = await readWrapped(tiers.cache, discordUserId, year, meetupId);
  if (hot || !tiers.entries) {
    return hot;
  }
  let stored: CachedWrapped | undefined;
  try {
    stored = await tiers.entries.get(discordUserId, year);
  } catch (error) {
    // Postgres down: the Redis tier already answered (a miss).
    logger.warn(`Wrapped entries read failed: ${errorName(error)}`);
    return undefined;
  }
  if (!stored || stored.meetupId !== meetupId) {
    return undefined;
  }
  if (isCurrentYear(year, now)) {
    await tiers.cache
      .set(
        wrappedCacheKey(discordUserId, year),
        JSON.stringify(stored),
        HOT_TTL_SEC,
      )
      .catch(() => undefined);
  }
  return stored;
}

export async function writeEntry(
  tiers: WrappedTiers,
  discordUserId: string,
  year: number,
  wrapped: CachedWrapped,
  now: Date,
): Promise<void> {
  if (!tiers.entries) {
    await writeWrapped(tiers.cache, discordUserId, year, wrapped, now);
    return;
  }
  try {
    await tiers.entries.put(discordUserId, year, wrapped, now);
  } catch (error) {
    // Postgres down: keep the build in Redis as before (the season TTL)
    // rather than lose it; the next build writes both tiers.
    logger.warn(`Wrapped entries write failed: ${errorName(error)}`);
    await writeWrapped(tiers.cache, discordUserId, year, wrapped, now);
    return;
  }
  const key = wrappedCacheKey(discordUserId, year);
  if (isCurrentYear(year, now)) {
    await tiers.cache.set(key, JSON.stringify(wrapped), HOT_TTL_SEC);
  } else {
    await tiers.cache.remove(key);
  }
}

/**
 * Where a built Wrapped lives (Redis, for the season) and how often one may
 * be built (once an hour per member). The cached value holds only the
 * member's own stats and the Discord ids of linked companions.
 */
import dayjs from 'dayjs';
import { Logger } from 'tslog';

import { KeyValueCache } from '../cache/base.js';
import { FixedWindowLimiter } from '../../web/rateLimit.js';
import { tz } from '../../util/timezone.js';
import { NamedCompanions } from './companions.js';
import { WrappedStats } from './stats.js';

const logger = new Logger({ name: 'wrappedCache' });

/** Bump whenever CachedWrapped's shape changes. */
export const WRAPPED_CACHE_VERSION = 'v1';
export const BUILD_WINDOW_MS = 60 * 60 * 1000;
export const SHARE_GUARD_TTL_SEC = 24 * 60 * 60;
const MIN_TTL_SEC = 24 * 60 * 60;

export interface CachedWrapped {
  stats: WrappedStats;
  companions: NamedCompanions;
  builtAt: string;
}

export function wrappedCacheKey(discordUserId: string, year: number): string {
  return `wrapped:${WRAPPED_CACHE_VERSION}:${discordUserId}:${year}`;
}

export function shareGuardKey(
  discordUserId: string,
  year: number,
  channelId: string,
): string {
  return `wrapped:shared:${discordUserId}:${year}:${channelId}`;
}

/**
 * Until 1 February of the following year (Pacific), so a Wrapped stays
 * through the season; a past year's lookback rebuilds daily.
 */
export function wrappedTtlSec(year: number, now: Date): number {
  const seasonEnd = tz(dayjs(now))
    .year(year + 1)
    .month(1)
    .date(1)
    .startOf('day');
  const untilSeasonEnd = Math.floor(
    (seasonEnd.valueOf() - now.getTime()) / 1000,
  );
  return Math.max(MIN_TTL_SEC, untilSeasonEnd);
}

export async function readWrapped(
  cache: KeyValueCache,
  discordUserId: string,
  year: number,
): Promise<CachedWrapped | undefined> {
  const raw = await cache.get(wrappedCacheKey(discordUserId, year));
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as CachedWrapped;
  } catch {
    logger.warn(`Unparseable cached Wrapped for ${discordUserId}/${year}`);
    return undefined;
  }
}

export async function writeWrapped(
  cache: KeyValueCache,
  discordUserId: string,
  year: number,
  wrapped: CachedWrapped,
  now: Date = new Date(),
): Promise<void> {
  await cache.set(
    wrappedCacheKey(discordUserId, year),
    JSON.stringify(wrapped),
    wrappedTtlSec(year, now),
  );
}

export function createBuildLimiter(
  now: () => number = Date.now,
): FixedWindowLimiter {
  return new FixedWindowLimiter(1, BUILD_WINDOW_MS, now);
}

/** In-process is enough: the bot runs on one dyno. */
export const wrappedBuildLimiter = createBuildLimiter();

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

/** The group's first year on Meetup; nothing to wrap before it. */
export const FIRST_WRAPPED_YEAR = 2015;
/** Bump whenever CachedWrapped's shape changes. */
export const WRAPPED_CACHE_VERSION = 'v4';
export const BUILD_WINDOW_MS = 60 * 60 * 1000;
export const SHARE_GUARD_TTL_SEC = 24 * 60 * 60;
/**
 * How long one build may hold the "already building" lease: the OAuth hop
 * alone can take three minutes, and the interaction token lasts fifteen.
 */
export const BUILDING_LEASE_TTL_SEC = 15 * 60;
const MIN_TTL_SEC = 24 * 60 * 60;
/** A year that has ended is final: its Wrapped keeps for a year. */
export const PAST_YEAR_TTL_SEC = 365 * 24 * 60 * 60;

export interface CachedWrapped {
  /** The Meetup account this was built for; a relink makes it a miss. */
  meetupId: string;
  stats: WrappedStats;
  companions: NamedCompanions;
  builtAt: string;
  /**
   * 'snapshot' when built from the group snapshot; absent for the token
   * path (and every copy built before the snapshot). Additive: readers that
   * do not know it ignore it, so no cache version bump.
   */
  builtFrom?: 'snapshot';
}

export function wrappedCacheKey(discordUserId: string, year: number): string {
  return `wrapped:${WRAPPED_CACHE_VERSION}:${discordUserId}:${year}`;
}

export function buildingKey(discordUserId: string, year: number): string {
  return `wrapped:building:${discordUserId}:${year}`;
}

export function shareGuardKey(
  discordUserId: string,
  year: number,
  channelId: string,
): string {
  return `wrapped:shared:${discordUserId}:${year}:${channelId}`;
}

/**
 * The current year: until 1 February of the following year (Pacific), so a
 * Wrapped stays through the season and a December copy is rebuilt once the
 * year is over. A past year's data is final, so it keeps for a year.
 */
export function wrappedTtlSec(year: number, now: Date): number {
  if (year < tz(dayjs(now)).year()) {
    return PAST_YEAR_TTL_SEC;
  }
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

/**
 * The cached Wrapped, or undefined when there is none, it is unparseable, or
 * it was built for a Meetup account other than `meetupId` (the member has
 * unlinked and relinked since).
 */
export async function readWrapped(
  cache: KeyValueCache,
  discordUserId: string,
  year: number,
  meetupId?: string,
): Promise<CachedWrapped | undefined> {
  const raw = await cache.get(wrappedCacheKey(discordUserId, year));
  if (raw === undefined) {
    return undefined;
  }
  let wrapped: CachedWrapped;
  try {
    wrapped = JSON.parse(raw) as CachedWrapped;
  } catch {
    logger.warn(`Unparseable cached Wrapped for ${discordUserId}/${year}`);
    return undefined;
  }
  if (meetupId !== undefined && wrapped.meetupId !== meetupId) {
    return undefined;
  }
  return wrapped;
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

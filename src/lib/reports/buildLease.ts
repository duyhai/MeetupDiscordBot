import { Logger } from 'tslog';
import { KeyValueCache } from '../cache/base.js';
import {
  identityDigestClaimKey,
  identityDigestDoneKey,
} from '../helpers/identity/digest.js';
import { utcDay } from './period.js';

const logger = new Logger({ name: 'reportBuildLease' });

export const BUILD_LEASE_KEY = 'report-build-claim';
export const BUILD_LEASE_TTL_SEC = 30 * 60;

/** Takes the lease with the caller's random value; false when another build holds it. */
export async function acquireBuildLease(
  cache: KeyValueCache,
  value: string,
): Promise<boolean> {
  return cache.exclusive_set(BUILD_LEASE_KEY, value, BUILD_LEASE_TTL_SEC);
}

/**
 * Removes `key` only if it still holds `value` (get-then-remove; see
 * releaseBuildLease for why that is accepted). False when it was not ours.
 * Cache errors propagate, for callers that must notice a failed release.
 */
export async function releaseOwnedKey(
  cache: KeyValueCache,
  key: string,
  value: string,
): Promise<boolean> {
  if ((await cache.get(key)) !== value) {
    return false;
  }
  await cache.remove(key);
  return true;
}

/**
 * Removes the lease only if it still holds our value (withLock's pattern in
 * src/util/lock.ts). If our lease expired and another build took it, theirs
 * is left alone.
 *
 * Not atomic: KeyValueCache has no compare-and-delete, so this is
 * get-then-remove. A lease that expires and is re-taken between the two
 * calls would still be removed; that needs a build to run almost exactly as
 * long as the 30-minute TTL and is accepted (the second build would then
 * overlap a third at worst, and each month build is idempotent).
 *
 * Never throws: a failed release only delays the next build by the TTL.
 */
export async function releaseBuildLease(
  cache: KeyValueCache,
  value: string,
): Promise<boolean> {
  try {
    if (!(await releaseOwnedKey(cache, BUILD_LEASE_KEY, value))) {
      logger.warn(
        'Report build lease was no longer ours at release; left in place',
      );
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`Failed to release the report build lease: ${String(error)}`);
    return false;
  }
}

/**
 * The identity digest claims today's key before its sweeps and writes the
 * done marker only after posting. Claim without done = a digest is running
 * (or died within its 30-minute lease). Days are UTC dates, as in digest.ts.
 * Cache errors propagate: the caller then does not build (fail closed).
 */
export async function identityDigestInProgress(
  cache: KeyValueCache,
  now: Date,
): Promise<boolean> {
  const day = utcDay(now);
  if (!(await cache.get(identityDigestClaimKey(day)))) {
    return false;
  }
  return !(await cache.get(identityDigestDoneKey(day)));
}

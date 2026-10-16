import { Logger } from 'tslog';

import { KeyValueCache } from '../lib/cache/base.js';
import {
  BUILD_LEASE_KEY,
  releaseBuildLease,
} from '../lib/reports/buildLease.js';

const logger = new Logger({ name: 'dashboard' });

export const DASHBOARD_CACHE_TIMEOUT_MS = 2_000;

export class CacheTimeoutError extends Error {
  constructor(op: string, ms: number) {
    super(`cache ${op} timed out after ${ms} ms`);
    this.name = 'CacheTimeoutError';
  }
}

export interface TimedCacheOptions {
  /** exclusive_set timed out, then won after all: the key is held by a caller that already gave up. */
  onLateExclusiveSet?: (key: string, value: string) => void;
}

function race<T>(op: string, ms: number, pending: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CacheTimeoutError(op, ms)), ms);
    // A pending deadline alone never holds the process open (shutdown, tests).
    timer.unref();
  });
  return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Dashboard-only: a Redis outage answers 503 in about 2 s instead of hanging
 * for Heroku's 30 s. The shared client is untouched, so the identity sweep,
 * OAuth state, token store and build job keep waiting for Redis as they were
 * designed to (the build job's wedged-tick alert depends on it).
 *
 * A timed-out command is still queued in node-redis and may run when Redis
 * returns. That is safe for every dashboard write: a late session set makes
 * a session whose cookie was never sent, a late destroy or revocation lands
 * late, and a late set_existing cannot resurrect anything. A late
 * exclusive_set win is reported through onLateExclusiveSet.
 */
export function timedCache(
  inner: KeyValueCache,
  ms = DASHBOARD_CACHE_TIMEOUT_MS,
  options: TimedCacheOptions = {},
): KeyValueCache {
  return {
    get: (key) => race('get', ms, inner.get(key)),
    set: (key, value, ttl) => race('set', ms, inner.set(key, value, ttl)),
    exclusive_set: (key, value, ttl) => {
      // Kept: it may still win after we give up.
      const pending = inner.exclusive_set(key, value, ttl);
      return race('exclusive_set', ms, pending).catch((error: unknown) => {
        const late = options.onLateExclusiveSet;
        if (error instanceof CacheTimeoutError && late) {
          pending.then(
            (won) => {
              if (won) {
                late(key, value);
              }
            },
            () => undefined,
          );
        }
        throw error;
      });
    },
    set_existing: (key, value, ttl) =>
      race('set_existing', ms, inner.set_existing(key, value, ttl)),
    remove: (key) => race('remove', ms, inner.remove(key)),
  };
}

/** Times obtaining the client too: the first connect can hang like any command. */
export function timedCacheFactory(
  get: () => Promise<KeyValueCache>,
  ms = DASHBOARD_CACHE_TIMEOUT_MS,
  options: TimedCacheOptions = {},
): () => Promise<KeyValueCache> {
  return async () => timedCache(await race('connect', ms, get()), ms, options);
}

/**
 * A manual refresh whose lease request timed out has already answered the
 * user; if Redis applies the SET NX later, the lease would sit ownerless for
 * its 30-minute TTL and every build would answer "busy". Release it as soon
 * as the late win is known, through the untimed inner cache, so the release
 * waits for Redis however long that takes. Value-compared, so another
 * build's lease is never touched; releaseBuildLease never throws.
 */
export function releaseLateBuildLease(
  getInner: () => Promise<KeyValueCache>,
  log: Pick<Logger<unknown>, 'warn' | 'error'> = logger,
): TimedCacheOptions {
  return {
    onLateExclusiveSet: (key, value) => {
      if (key !== BUILD_LEASE_KEY) {
        // Only the lease; other late writes are harmless (see timedCache).
        return;
      }
      log.warn(
        'Report build lease was granted after its request timed out; releasing it',
      );
      getInner()
        .then((inner) => releaseBuildLease(inner, value))
        .catch((error: unknown) =>
          log.error(
            `Late build lease release failed: ${error instanceof Error ? error.name : 'Error'}`,
          ),
        );
    },
  };
}

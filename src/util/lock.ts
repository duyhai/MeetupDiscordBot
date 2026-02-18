import { Logger } from 'tslog';
import { InMemoryCache } from '../lib/cache/memoryCache';
import { RedisCache } from '../lib/cache/redisCache';

const logger = new Logger({ name: 'withLock' });

/**
 * Executes a function within an exclusive lock.
 */
export async function withLock({
  cache,
  lockKey,
  lockId,
  fn,
  errorMsg,
}: {
  cache: RedisCache | InMemoryCache;
  errorMsg?: string;
  fn: () => Promise<void>;
  lockId: string;
  lockKey: string;
}) {
  logger.info(`Acquiring lock ${JSON.stringify({ key: lockKey, id: lockId })}`);
  if (!(await cache.exclusive_set(lockKey, lockId))) {
    logger.info(
      `Lock is already taken ${JSON.stringify({ key: lockKey, id: lockId })}`,
    );
    throw new Error(errorMsg);
  }

  try {
    await fn();
  } finally {
    // Free lock
    logger.info(
      `Checking lock to free ${JSON.stringify({ key: lockKey, id: lockId })}`,
    );
    if ((await cache.get(lockKey)) === lockId) {
      logger.info(
        `Freeing lock ${JSON.stringify({ key: lockKey, id: lockId })}`,
      );
      await cache.remove(lockKey);
    }
  }
}

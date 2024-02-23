import { InMemoryCache } from '../lib/cache/memoryCache';
import { RedisCache } from '../lib/cache/redisCache';

export const ApplicationCache = async () => {
  if (!process.env.REDISCLOUD_URL) {
    return InMemoryCache.instance();
  }
  const redisCache = new RedisCache();
  await redisCache.connect();
  return redisCache;
};

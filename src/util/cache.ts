import { InMemoryCache } from '../lib/cache/memoryCache';
import { RedisCache } from '../lib/cache/redisCache';

export const ApplicationCache = async () => {
  return process.env.REDISCLOUD_URL
    ? RedisCache.instance()
    : InMemoryCache.instance();
};

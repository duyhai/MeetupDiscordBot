import { InMemoryCache } from '../lib/cache/memoryCache.js';
import { RedisCache } from '../lib/cache/redisCache.js';

export const ApplicationCache = async () => {
  return process.env.REDISCLOUD_URL
    ? RedisCache.instance()
    : InMemoryCache.instance();
};

import * as redis from 'redis';
import { KeyValueCache } from './base';

const ITEM_TTL_SEC = 60 * 60 * 12;
/**
 * Wrapper around Redis
 */
export class RedisCache implements KeyValueCache {
  private client: redis.RedisClientType;

  private static singleton: RedisCache;

  public constructor() {
    this.client = redis.createClient({
      url: process.env.REDISCLOUD_URL,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async remove(key: string): Promise<void> {
    await this.client.del(key);
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.client.get(key);
    return value ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.client.set(key, value, { EX: ITEM_TTL_SEC });
  }
}

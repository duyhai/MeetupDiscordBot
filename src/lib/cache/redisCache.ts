import * as redis from 'redis';
import { KeyValueCache } from './base';

const ITEM_TTL_SEC = 60 * 60 * 12;
/**
 * Wrapper around Redis
 */
export class RedisCache implements KeyValueCache {
  private client: redis.RedisClientType;

  private static singleton: RedisCache;

  private constructor() {
    this.client = redis.createClient({
      url: process.env.REDISCLOUD_URL,
    });
  }

  public static async instance(): Promise<RedisCache> {
    if (this.singleton === undefined) {
      this.singleton = new RedisCache();
      await this.singleton.connect();
    }
    return this.singleton;
  }

  private async connect(): Promise<void> {
    await this.client.connect();
  }

  async remove(key: string): Promise<void> {
    await this.client.del(key);
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.client.get(key);
    return (value as string | null) ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.client.set(key, value, { EX: ITEM_TTL_SEC });
  }

  async exclusive_set(key: string, value: string): Promise<boolean> {
    const result = await this.client.set(key, value, {
      NX: true,
      EX: ITEM_TTL_SEC,
    });
    return result === 'OK';
  }
}

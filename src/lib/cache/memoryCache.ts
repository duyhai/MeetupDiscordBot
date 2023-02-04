import { MemoryCache } from 'memory-cache-node';

import { KeyValueCache } from './base';

const EXPIRATION_CHECK_INTERVAL_SECS = 60;
const ITEM_TTL_SEC = 50 * 60;
const MAX_ITEMS = 1000000;

/**
 * Wrapper around an in-memory cache package
 */
export class InMemoryCache implements KeyValueCache {
  private cache: MemoryCache<string, string>;

  private static singleton: InMemoryCache;

  private constructor() {
    this.cache = new MemoryCache<string, string>(
      EXPIRATION_CHECK_INTERVAL_SECS,
      MAX_ITEMS
    );
  }

  public static instance(): InMemoryCache {
    if (this.singleton === undefined) {
      this.singleton = new InMemoryCache();
    }
    return this.singleton;
  }

  async remove(key: string): Promise<void> {
    this.cache.removeItem(key);
  }

  async get(key: string): Promise<string> {
    return this.cache.retrieveItemValue(key);
  }

  async has(key: string): Promise<boolean> {
    return this.cache.hasItem(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.cache.storeExpiringItem(key, value, ITEM_TTL_SEC);
  }
}

import { KeyValueCache } from '../../src/lib/cache/base.js';

/** Map-backed cache that records each key's TTL for assertions. */
export class FakeCache implements KeyValueCache {
  readonly values = new Map<string, string>();

  readonly ttls = new Map<string, number | undefined>();

  async get(key: string) {
    return this.values.get(key);
  }

  async set(key: string, value: string, ttlSec?: number) {
    this.values.set(key, value);
    this.ttls.set(key, ttlSec);
  }

  async exclusive_set(key: string, value: string, ttlSec?: number) {
    if (this.values.has(key)) {
      return false;
    }
    await this.set(key, value, ttlSec);
    return true;
  }

  async set_existing(key: string, value: string, ttlSec?: number) {
    if (!this.values.has(key)) {
      return false;
    }
    await this.set(key, value, ttlSec);
    return true;
  }

  async remove(key: string) {
    this.values.delete(key);
    this.ttls.delete(key);
  }
}

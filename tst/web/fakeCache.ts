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

/**
 * FakeCache whose keys expire on `clock` (epoch ms), as Redis keys would: a
 * key set with a TTL is gone once the clock reaches its expiry.
 */
export class ClockedCache extends FakeCache {
  private readonly expiresAt = new Map<string, number>();

  constructor(private readonly epochMs: () => number) {
    super();
  }

  private dropIfExpired(key: string): void {
    const at = this.expiresAt.get(key);
    if (at !== undefined && this.epochMs() >= at) {
      this.values.delete(key);
      this.ttls.delete(key);
      this.expiresAt.delete(key);
    }
  }

  override async get(key: string) {
    this.dropIfExpired(key);
    return super.get(key);
  }

  override async set(key: string, value: string, ttlSec?: number) {
    await super.set(key, value, ttlSec);
    if (ttlSec === undefined) {
      this.expiresAt.delete(key);
    } else {
      this.expiresAt.set(key, this.epochMs() + ttlSec * 1000);
    }
  }

  override async exclusive_set(key: string, value: string, ttlSec?: number) {
    this.dropIfExpired(key);
    return super.exclusive_set(key, value, ttlSec);
  }

  override async set_existing(key: string, value: string, ttlSec?: number) {
    this.dropIfExpired(key);
    return super.set_existing(key, value, ttlSec);
  }

  override async remove(key: string) {
    this.expiresAt.delete(key);
    await super.remove(key);
  }
}

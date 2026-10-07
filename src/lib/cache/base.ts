/**
 * Cache interface. The Cache name is taken, so we have to use a different name
 */

export interface KeyValueCache {
  /**
   * Sets `key` only if it is absent, returning whether this caller won.
   *
   * `ttlSec` overrides the implementation's default expiry, as on `set`.
   * Callers that use this as a lease -- "I am working on this, and if I die
   * someone else should pick it up" -- need the TTL to match how long the
   * work plausibly takes, which is not the same as the cache's general-purpose
   * item lifetime.
   */
  exclusive_set(key: string, value: string, ttlSec?: number): Promise<boolean>;
  get(key: string): Promise<string | undefined>;
  remove(key: string): Promise<void>;
  /** `ttlSec` overrides the implementation's default expiry. */
  set(key: string, value: string, ttlSec?: number): Promise<void>;
}

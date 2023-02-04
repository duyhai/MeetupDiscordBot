/**
 * Cache interface. The Cache name is taken, so we have to use a different name
 */

export interface KeyValueCache {
  get(key: string): Promise<string>;
  has(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  set(key: string, value: string): Promise<void>;
}

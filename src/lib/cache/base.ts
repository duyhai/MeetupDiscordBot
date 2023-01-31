/**
 * Cache interface. The Cache name is taken, so we have to use a different name
 */

export interface KeyValueCache {
  get(key: string): string;
  has(key: string): boolean;
  remove(key: string): void;
  set(key: string, value: string): void;
}

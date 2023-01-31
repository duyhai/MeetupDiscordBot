import { KeyValueCache } from './base';

/**
 * Wrapper around Redis
 */
export class RedisCache implements KeyValueCache {
  remove(key: string): void {
    throw Error('Not Implemented');
  }

  get(key: string): string {
    throw Error('Not Implemented');
  }

  has(key: string): boolean {
    throw Error('Not Implemented');
  }

  set(key: string, value: string): void {
    throw Error('Not Implemented');
  }
}

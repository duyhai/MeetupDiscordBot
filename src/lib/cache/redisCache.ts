import { KeyValueCache } from './base';

/**
 * Wrapper around Redis
 */
export class RedisCache implements KeyValueCache {
  remove(_key: string): void {
    throw Error('Not Implemented');
  }

  get(_key: string): string {
    throw Error('Not Implemented');
  }

  has(_key: string): boolean {
    throw Error('Not Implemented');
  }

  set(_key: string, _value: string): void {
    throw Error('Not Implemented');
  }
}

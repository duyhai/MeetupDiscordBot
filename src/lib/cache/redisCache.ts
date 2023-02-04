import { KeyValueCache } from './base';

/**
 * Wrapper around Redis
 */
export class RedisCache implements KeyValueCache {
  async remove(_key: string): Promise<void> {
    throw Error('Not Implemented');
  }

  async get(_key: string): Promise<string> {
    throw Error('Not Implemented');
  }

  async has(_key: string): Promise<boolean> {
    throw Error('Not Implemented');
  }

  async set(_key: string, _value: string): Promise<void> {
    throw Error('Not Implemented');
  }
}

import { afterEach, describe, expect, it } from 'vitest';

import { PostgresMemberRepository } from '../../../src/lib/repositories/postgresMemberRepository.js';

describe('PostgresMemberRepository.instance', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('rejects with a clear error when DATABASE_URL is unset', async () => {
    delete process.env.DATABASE_URL;

    await expect(PostgresMemberRepository.instance()).rejects.toThrow(
      'DATABASE_URL',
    );
  });
});

import crypto from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { PostgresCredentialRepository } from '../../src/lib/repositories/postgresCredentialRepository.js';
import { Tokens } from '../../src/lib/client/discord/types.js';

// Exercises the upsert conflict target and TIMESTAMPTZ handling against a
// real Postgres -- a mock would paper over both. Requires DATABASE_URL;
// skipped otherwise, matching the identity repository suite.
// Locally: yarn test:integration:docker
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresCredentialRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const freshTokens = (): Tokens => ({
  accessToken: `access-${crypto.randomUUID()}`,
  refreshToken: `refresh-${crypto.randomUUID()}`,
  expiresAt: Date.now() + 3600 * 1000,
});

describe.skipIf(!POSTGRES_AVAILABLE)('PostgresCredentialRepository', () => {
  let repo: PostgresCredentialRepository;

  beforeAll(async () => {
    repo = await PostgresCredentialRepository.instance();
  });

  it('round-trips a token set', async () => {
    const key = `key-${crypto.randomUUID()}`;
    const tokens = freshTokens();

    await repo.put(key, tokens);
    const stored = await repo.get(key);

    expect(stored?.accessToken).toBe(tokens.accessToken);
    expect(stored?.refreshToken).toBe(tokens.refreshToken);
    // expiresAt round-trips through a TIMESTAMPTZ column, which only holds
    // millisecond precision -- matching the input's own precision here.
    expect(stored?.expiresAt).toBe(tokens.expiresAt);
  });

  it('overwrites rather than duplicates on repeated put', async () => {
    const key = `key-${crypto.randomUUID()}`;
    await repo.put(key, freshTokens());
    const updated = freshTokens();
    await repo.put(key, updated);

    const stored = await repo.get(key);
    expect(stored?.accessToken).toBe(updated.accessToken);
    expect(stored?.refreshToken).toBe(updated.refreshToken);
  });

  it('returns undefined for an absent key', async () => {
    expect(await repo.get(`missing-${crypto.randomUUID()}`)).toBeUndefined();
  });

  it('clear removes the stored credential', async () => {
    const key = `key-${crypto.randomUUID()}`;
    await repo.put(key, freshTokens());

    await repo.clear(key);

    expect(await repo.get(key)).toBeUndefined();
  });
});

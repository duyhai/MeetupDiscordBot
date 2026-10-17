import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Configuration from '../../../src/configuration.js';
import { GUILD_ID } from '../../../src/constants.js';

/** Every query the fake pool or its clients were sent, in order. */
const calls = vi.hoisted(
  () => [] as { via: 'pool' | 'client'; text: string; values?: unknown[] }[],
);

const EMPTY = { rows: [], rowCount: 0 };

// No database: the repository's pool and its clients only record what they are sent.
vi.mock('pg', () => {
  class Pool {
    on() {
      return this;
    }

    query(text: string, values?: unknown[]) {
      calls.push({ via: 'pool', text, values });
      return Promise.resolve(EMPTY);
    }

    connect() {
      return Promise.resolve({
        query: (text: string, values?: unknown[]) => {
          calls.push({ via: 'client', text, values });
          return Promise.resolve(EMPTY);
        },
        on() {},
        removeListener() {},
        release() {},
      });
    }
  }
  return { default: { Pool } };
});

type Repo =
  import('../../../src/lib/repositories/postgresIdentityRepository.js').PostgresIdentityRepository;

const thumbQueries = () =>
  calls.filter(
    (c) => c.via === 'pool' && c.text.includes('FROM member_identity_changes'),
  );

/** The value bound to the placeholder that follows `marker` in the SQL. */
function boundAfter(text: string, values: unknown[], marker: string) {
  const at = text.indexOf(marker);
  const match = /^\$([0-9]+)/.exec(text.slice(at + marker.length));
  if (at < 0 || !match) {
    return undefined;
  }
  return values[Number(match[1]) - 1];
}

describe('PostgresIdentityRepository.getChangeThumb scope', () => {
  const saved = { ...process.env };
  let repo: Repo;

  beforeEach(async () => {
    process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:1/x';
    vi.resetModules();
    const mod =
      await import('../../../src/lib/repositories/postgresIdentityRepository.js');
    repo = await mod.PostgresIdentityRepository.instance();
    calls.length = 0;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('getChangeThumb filters by the monitored scopes', async () => {
    await expect(repo.getChangeThumb('1', 'old')).resolves.toBeUndefined();
    const queries = thumbQueries();
    expect(queries).toHaveLength(1);
    const { text } = queries[0];
    expect(text).toContain('WHERE id = $1::bigint AND');
    expect(text).toContain("(platform, scope_id) IN (('discord', $2),");
    expect(text).toContain("('meetup', $3))");
  });

  it('getChangeThumb passes the guild and group ids after the id', async () => {
    await repo.getChangeThumb('1', 'new');
    const [{ text, values }] = thumbQueries();
    expect(values).toEqual(['1', GUILD_ID, Configuration.meetup.groupId]);
    // Each scope placeholder is bound to its own platform's id.
    expect(boundAfter(text, values ?? [], "('discord', ")).toBe(GUILD_ID);
    expect(boundAfter(text, values ?? [], "('meetup', ")).toBe(
      Configuration.meetup.groupId,
    );
    expect(boundAfter(text, values ?? [], 'WHERE id = ')).toBe('1');
  });

  it('getChangeThumb refuses a bad id or side before querying', async () => {
    await expect(repo.getChangeThumb('1x', 'old')).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      repo.getChangeThumb('1234567890123456789', 'old'),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      repo.getChangeThumb('1', 'both' as 'old'),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });
});

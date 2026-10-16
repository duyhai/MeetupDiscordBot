import { Client } from 'discord.js';
import pg from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import Configuration from '../../src/configuration.js';
import { Tokens } from '../../src/lib/client/discord/types.js';
import { refreshMeetupToken } from '../../src/lib/client/oauth/providers.js';
import {
  getOrganizerAccessToken,
  resetOrganizerTokenStateForTest,
} from '../../src/lib/helpers/organizerMeetupClient.js';
import {
  ORGANIZER_CREDENTIAL_LOCK,
  PostgresCredentialRepository,
} from '../../src/lib/repositories/postgresCredentialRepository.js';
import {
  ApplicationCredentialRepository,
  MEETUP_ORGANIZER_CREDENTIAL_KEY,
} from '../../src/util/credentialRepository.js';

// Two "processes" -- two repository instances, each with its own pool and so
// its own Postgres session -- race getOrganizerAccessToken itself. The lock
// must make exactly one of them refresh, and the other reuse what it stored.
// Meetup and Discord are mocked; requires DATABASE_URL, skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

vi.mock('../../src/lib/client/oauth/providers.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/lib/client/oauth/providers.js')
  >()),
  refreshMeetupToken: vi.fn(),
}));

vi.mock('../../src/lib/helpers/discordLogger.js', () => ({
  logAlert: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/lib/client/meetup/gqlClient.js', () => ({
  GqlMeetupClient: class {
    getSelfId = vi.fn().mockResolvedValue('468174923');
  },
}));

vi.mock('../../src/util/credentialRepository.js', () => ({
  ApplicationCredentialRepository: vi.fn(),
  MEETUP_ORGANIZER_CREDENTIAL_KEY: 'meetup_organizer',
}));

const refresh = vi.mocked(refreshMeetupToken);
const KEY = MEETUP_ORGANIZER_CREDENTIAL_KEY;
const LOCK_CLASSID = Math.floor(ORGANIZER_CREDENTIAL_LOCK / 2 ** 32);
const LOCK_OBJID = ORGANIZER_CREDENTIAL_LOCK % 2 ** 32;

describe.skipIf(!POSTGRES_AVAILABLE)(
  'getOrganizerAccessToken across two processes (Postgres)',
  () => {
    let first: PostgresCredentialRepository;
    let second: PostgresCredentialRepository;
    let observer: pg.Client;

    beforeAll(async () => {
      first = PostgresCredentialRepository.createIsolatedForTest();
      second = PostgresCredentialRepository.createIsolatedForTest();
      observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await observer.connect();
    });

    afterAll(async () => {
      await observer?.end();
      await first?.end();
      await second?.end();
      Configuration.meetup.organizerRefreshToken = undefined;
    });

    beforeEach(async () => {
      resetOrganizerTokenStateForTest();
      refresh.mockReset();
      Configuration.meetup.organizerRefreshToken = 'SEED-REFRESH';
      // Make sure the tables exist before clearing them.
      await first.getMeta(KEY);
      await observer.query('DELETE FROM oauth_credentials WHERE key = $1', [
        KEY,
      ]);
      await observer.query('DELETE FROM oauth_credential_meta WHERE key = $1', [
        KEY,
      ]);
    });

    it('exactly one refreshes, and both callers get the same token', async () => {
      await first.put(KEY, {
        accessToken: 'EXPIRED-ACCESS',
        refreshToken: 'STORED-REFRESH',
        expiresAt: Date.now() - 1000,
      });
      await observer.query(
        `INSERT INTO oauth_credential_meta (key, member_id) VALUES ($1, '468174923')`,
        [KEY],
      );

      let releaseRefresh!: (tokens: Tokens) => void;
      refresh.mockImplementationOnce(
        () =>
          new Promise<Tokens>((resolve) => {
            releaseRefresh = resolve;
          }),
      );
      vi.mocked(ApplicationCredentialRepository)
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);

      // Process A takes the lock and is mid-refresh.
      const a = getOrganizerAccessToken({ client: {} as Client });
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

      // Process B (a client-less script: a different in-process key, so it
      // does not join A) queues on the advisory lock.
      const b = getOrganizerAccessToken();
      await vi.waitFor(async () => {
        const { rows } = await observer.query<{ waiting: string }>(
          `SELECT count(*) AS waiting FROM pg_locks
            WHERE locktype = 'advisory' AND classid = $1 AND objid = $2
              AND objsubid = 1 AND NOT granted`,
          [LOCK_CLASSID, LOCK_OBJID],
        );
        expect(Number(rows[0].waiting)).toBe(1);
      });

      releaseRefresh({
        accessToken: 'ACCESS-A',
        refreshToken: 'ROTATED-A',
        expiresAt: Date.now() + 3600 * 1000,
      });

      await expect(Promise.all([a, b])).resolves.toEqual([
        'ACCESS-A',
        'ACCESS-A',
      ]);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith('STORED-REFRESH');
      expect((await second.get(KEY))?.refreshToken).toBe('ROTATED-A');
    });
  },
);

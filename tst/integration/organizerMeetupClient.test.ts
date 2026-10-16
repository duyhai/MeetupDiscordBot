import crypto from 'crypto';
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
import { logAlert } from '../../src/lib/helpers/discordLogger.js';
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

// The helper against the real locked repository: the rotated token and the
// failure episode must both survive the transaction's COMMIT. Meetup and
// Discord are mocked; requires DATABASE_URL, skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

// The real MeetupTokenRefreshError: the seed gate tells rejections apart by it.
vi.mock('../../src/lib/client/oauth/providers.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/lib/client/oauth/providers.js')
  >()),
  refreshMeetupToken: vi.fn(),
}));

vi.mock('../../src/lib/helpers/discordLogger.js', () => ({
  logAlert: vi.fn().mockResolvedValue(true),
}));

const fake = vi.hoisted(() => ({ getSelfId: vi.fn() }));

vi.mock('../../src/lib/client/meetup/gqlClient.js', () => ({
  GqlMeetupClient: class {
    getSelfId = fake.getSelfId;
  },
}));

// The real factory, unless a test hands out its own repository instances.
vi.mock('../../src/util/credentialRepository.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/util/credentialRepository.js')
    >();
  return {
    ...actual,
    ApplicationCredentialRepository: vi.fn(
      actual.ApplicationCredentialRepository,
    ),
  };
});

const refresh = vi.mocked(refreshMeetupToken);
const alert = vi.mocked(logAlert);
const client = {} as Client;
const KEY = MEETUP_ORGANIZER_CREDENTIAL_KEY;
const LOCK_CLASSID = Math.floor(ORGANIZER_CREDENTIAL_LOCK / 2 ** 32);
const LOCK_OBJID = ORGANIZER_CREDENTIAL_LOCK % 2 ** 32;

describe.skipIf(!POSTGRES_AVAILABLE)(
  'getOrganizerAccessToken (Postgres)',
  () => {
    let repo: PostgresCredentialRepository;
    let observer: pg.Client;

    beforeAll(async () => {
      repo = await PostgresCredentialRepository.instance();
      observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await observer.connect();
    });

    afterAll(async () => {
      await observer?.end();
      Configuration.meetup.organizerRefreshToken = undefined;
    });

    beforeEach(async () => {
      resetOrganizerTokenStateForTest();
      refresh.mockReset();
      alert.mockClear();
      fake.getSelfId.mockReset();
      fake.getSelfId.mockResolvedValue('468174923');
      Configuration.meetup.organizerRefreshToken = 'SEED-REFRESH';
      await observer.query('DELETE FROM oauth_credentials WHERE key = $1', [
        KEY,
      ]);
      await observer.query('DELETE FROM oauth_credential_meta WHERE key = $1', [
        KEY,
      ]);
    });

    it('persists the rotated token, then reuses it without refreshing', async () => {
      refresh.mockResolvedValueOnce({
        accessToken: 'ACCESS-1',
        refreshToken: 'ROTATED-1',
        expiresAt: Date.now() + 3600 * 1000,
      });

      await expect(getOrganizerAccessToken()).resolves.toBe('ACCESS-1');
      expect(refresh).toHaveBeenCalledWith('SEED-REFRESH');
      expect((await repo.get(KEY))?.refreshToken).toBe('ROTATED-1');
      expect((await repo.getMeta(KEY)).memberId).toBe('468174923');

      await expect(getOrganizerAccessToken()).resolves.toBe('ACCESS-1');
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('commits the failure episode, alerts once, and recovers once', async () => {
      refresh.mockRejectedValue(new Error('refused'));

      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();
      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();
      expect((await repo.getMeta(KEY)).failingSince).not.toBeNull();
      expect(alert).toHaveBeenCalledTimes(1);

      refresh.mockReset();
      refresh.mockResolvedValueOnce({
        accessToken: 'ACCESS-2',
        refreshToken: 'ROTATED-2',
        expiresAt: Date.now() + 3600 * 1000,
      });
      await expect(getOrganizerAccessToken({ client })).resolves.toBe(
        'ACCESS-2',
      );
      expect((await repo.getMeta(KEY)).failingSince).toBeNull();
      expect(alert).toHaveBeenCalledTimes(2);
      expect(alert.mock.calls[1][1].title).toBe(
        'Meetup organizer login restored',
      );
    });

    it('a wrong-account refresh leaves oauth_credentials unchanged', async () => {
      const before = {
        accessToken: 'STORED-ACCESS',
        refreshToken: 'STORED-REFRESH',
        expiresAt: Date.now() - 1000, // expired: forces a refresh
      };
      await repo.put(KEY, before);
      await observer.query(
        `INSERT INTO oauth_credential_meta (key, member_id) VALUES ($1, '468174923')`,
        [KEY],
      );
      const rowBefore = (
        await observer.query<Record<string, unknown>>(
          'SELECT access_token, refresh_token, expires_at, updated_at FROM oauth_credentials WHERE key = $1',
          [KEY],
        )
      ).rows[0];
      refresh.mockResolvedValueOnce({
        accessToken: 'PERSONAL-ACCESS',
        refreshToken: 'PERSONAL-REFRESH',
        expiresAt: Date.now() + 3600 * 1000,
      });
      fake.getSelfId.mockResolvedValue('999000111');

      await expect(
        getOrganizerAccessToken({ client }),
      ).resolves.toBeUndefined();

      const rowAfter = (
        await observer.query<Record<string, unknown>>(
          'SELECT access_token, refresh_token, expires_at, updated_at FROM oauth_credentials WHERE key = $1',
          [KEY],
        )
      ).rows[0];
      expect(rowAfter).toEqual(rowBefore);
      const meta = await repo.getMeta(KEY);
      expect(meta.memberId).toBe('468174923');
      expect(meta.failingSince).not.toBeNull(); // the episode opened
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0][1].description).toMatch(
        /different Meetup account/,
      );
    });

    it('a bookkeeping failure does not lose the credential write', async () => {
      await repo.put(KEY, {
        accessToken: 'STORED-ACCESS',
        refreshToken: 'STORED-REFRESH',
        expiresAt: Date.now() - 1000, // expired: forces a refresh
      });
      await observer.query(
        `INSERT INTO oauth_credential_meta (key, member_id, failing_since)
         VALUES ($1, '468174923', now())`,
        [KEY],
      );
      // A real statement error in the episode close: any UPDATE of this
      // key's meta row raises, as a dropped column or a bad deploy would.
      await observer.query(`
        CREATE OR REPLACE FUNCTION refuse_organizer_meta_update() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'bookkeeping refused'; END $$`);
      await observer.query(`
        CREATE TRIGGER refuse_organizer_meta_update
        BEFORE UPDATE ON oauth_credential_meta FOR EACH ROW
        WHEN (OLD.key = 'meetup_organizer')
        EXECUTE FUNCTION refuse_organizer_meta_update()`);
      const locks = vi.spyOn(repo, 'withLockedCredential');
      refresh.mockResolvedValueOnce({
        accessToken: 'ACCESS-3',
        refreshToken: 'ROTATED-3',
        expiresAt: Date.now() + 3600 * 1000,
      });

      let lockedCalls: number;
      try {
        await expect(getOrganizerAccessToken({ client })).resolves.toBe(
          'ACCESS-3',
        );
      } finally {
        lockedCalls = locks.mock.calls.length;
        locks.mockRestore();
        await observer.query(
          'DROP TRIGGER IF EXISTS refuse_organizer_meta_update ON oauth_credential_meta',
        );
        await observer.query(
          'DROP FUNCTION IF EXISTS refuse_organizer_meta_update()',
        );
      }

      // Committed by the token transaction itself, not rescued by a retry.
      expect(lockedCalls).toBe(1);
      const row = await repo.get(KEY);
      expect(row?.accessToken).toBe('ACCESS-3');
      expect(row?.refreshToken).toBe('ROTATED-3');
      // The close was undone with its savepoint: still failing, no recovery.
      expect((await repo.getMeta(KEY)).failingSince).not.toBeNull();
      expect(alert).not.toHaveBeenCalled();
    });

    it('two processes racing: exactly one refreshes, and both get the same token', async () => {
      // Two repository instances, each with its own pool and so its own
      // Postgres session, stand in for two processes.
      const first = PostgresCredentialRepository.createIsolatedForTest();
      // Named, so B's own backend can be told from any other lock waiter.
      const raceB = `race-b-${crypto.randomUUID()}`;
      const second = PostgresCredentialRepository.createIsolatedForTest({
        applicationName: raceB,
      });
      const bIsQueued = async (): Promise<boolean> => {
        const { rows } = await observer.query<{ waiting: string }>(
          `SELECT count(*) AS waiting
             FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.objid = $2
              AND l.objsubid = 1 AND NOT l.granted
              AND a.application_name = $3`,
          [LOCK_CLASSID, LOCK_OBJID, raceB],
        );
        return Number(rows[0].waiting) === 1;
      };
      try {
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
        const a = getOrganizerAccessToken({ client });
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

        // Process B (a client-less script: a different in-process key, so
        // it does not join A) queues on the advisory lock.
        // Wait until B's own backend is queued -- or, if nothing serializes
        // them, until B has refreshed too, so the assertions below say so.
        const b = getOrganizerAccessToken();
        let sawBQueued = false;
        await vi.waitFor(async () => {
          sawBQueued = await bIsQueued();
          expect(sawBQueued || refresh.mock.calls.length >= 2).toBe(true);
        });

        releaseRefresh({
          accessToken: 'ACCESS-A',
          refreshToken: 'ROTATED-A',
          expiresAt: Date.now() + 3600 * 1000,
        });
        const results = await Promise.all([a, b]);

        // The double-refresh check first: it is what the lock prevents.
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(sawBQueued).toBe(true); // the race really happened
        expect(results).toEqual(['ACCESS-A', 'ACCESS-A']);
        expect(refresh).toHaveBeenCalledWith('STORED-REFRESH');
        expect((await repo.get(KEY))?.refreshToken).toBe('ROTATED-A');
      } finally {
        await first.end();
        await second.end();
      }
    });
  },
);

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
import { refreshMeetupToken } from '../../src/lib/client/oauth/providers.js';
import { logAlert } from '../../src/lib/helpers/discordLogger.js';
import {
  getOrganizerAccessToken,
  resetOrganizerTokenStateForTest,
} from '../../src/lib/helpers/organizerMeetupClient.js';
import { PostgresCredentialRepository } from '../../src/lib/repositories/postgresCredentialRepository.js';
import { MEETUP_ORGANIZER_CREDENTIAL_KEY } from '../../src/util/credentialRepository.js';

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

const refresh = vi.mocked(refreshMeetupToken);
const alert = vi.mocked(logAlert);
const client = {} as Client;
const KEY = MEETUP_ORGANIZER_CREDENTIAL_KEY;

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
  },
);

import { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Configuration from '../../src/configuration.js';
import { Tokens } from '../../src/lib/client/discord/types.js';
import {
  logAlert,
  logModeration,
} from '../../src/lib/helpers/discordLogger.js';
import {
  ORGANIZER_RESTORED_ALERT,
  noteOrganizerCredentialRenewed,
} from '../../src/lib/helpers/organizerMeetupClient.js';
import {
  CredentialMeta,
  LockedCredential,
} from '../../src/lib/repositories/postgresCredentialRepository.js';
import { ApplicationCredentialRepository } from '../../src/util/credentialRepository.js';
import {
  OrganizerAccountChangedError,
  organizerLoginDeps,
} from '../../src/web/organizerLoginDeps.js';

const fake = vi.hoisted(() => ({ getSelfId: vi.fn() }));

vi.mock('../../src/lib/helpers/discordLogger.js', () => ({
  logAlert: vi.fn().mockResolvedValue(true),
  logModeration: vi.fn().mockResolvedValue(true),
  logActivity: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/lib/helpers/organizerMeetupClient.js', async (original) => ({
  ...(await original<object>()),
  noteOrganizerCredentialRenewed: vi.fn(),
}));

vi.mock('../../src/lib/client/meetup/gqlClient.js', () => ({
  GqlMeetupClient: class {
    getSelfId = fake.getSelfId;
  },
}));

const KEY = 'meetup_organizer';
const ORGANIZER_ID = '468174923';
const TOKENS: Tokens = {
  accessToken: 'ACCESS',
  refreshToken: 'REFRESH',
  expiresAt: Date.now() + 3600_000,
};

const events: string[] = [];
const db = {
  meta: { memberId: null, failingSince: null } as CredentialMeta,
  failing: false,
};
const locked = {
  write: vi.fn(async () => {
    events.push('write');
  }),
  setMemberId: vi.fn(async (id: string) => {
    events.push(`setMemberId ${id}`);
  }),
  markFailing: vi.fn(),
  clearFailing: vi.fn(async () => {
    events.push('clearFailing');
    return db.failing;
  }),
};
const repo = {
  getMeta: vi.fn(async () => db.meta),
  withLockedCredential: vi.fn(
    async <T>(key: string, fn: (l: LockedCredential) => Promise<T>) => {
      events.push(`lock ${key}`);
      const result = await fn({ current: undefined, meta: db.meta, ...locked });
      events.push('commit');
      return result;
    },
  ),
};

vi.mock('../../src/util/credentialRepository.js', () => ({
  ApplicationCredentialRepository: vi.fn(),
  MEETUP_ORGANIZER_CREDENTIAL_KEY: 'meetup_organizer',
}));

const client = {} as Client;

beforeEach(() => {
  events.length = 0;
  db.meta = { memberId: null, failingSince: null };
  db.failing = false;
  vi.clearAllMocks();
  vi.mocked(ApplicationCredentialRepository).mockResolvedValue(
    repo as unknown as Awaited<
      ReturnType<typeof ApplicationCredentialRepository>
    >,
  );
  vi.mocked(logAlert).mockImplementation(async () => {
    events.push('alert');
    return true;
  });
  vi.mocked(noteOrganizerCredentialRenewed).mockImplementation(() => {
    events.push('note');
  });
  Configuration.meetup.organizerMemberId = undefined;
});

afterEach(() => {
  Configuration.meetup.organizerMemberId = undefined;
});

describe('organizerLoginDeps', () => {
  it('bootstrap: uses MEETUP_ORGANIZER_MEMBER_ID when none is recorded', async () => {
    Configuration.meetup.organizerMemberId = ORGANIZER_ID;
    await expect(
      organizerLoginDeps(() => client).expectedMemberId(),
    ).resolves.toBe(ORGANIZER_ID);
    expect(repo.getMeta).toHaveBeenCalledWith(KEY);
  });

  it('bootstrap: the recorded member id wins over the config var', async () => {
    Configuration.meetup.organizerMemberId = '111';
    db.meta = { memberId: ORGANIZER_ID, failingSince: null };
    await expect(
      organizerLoginDeps(() => client).expectedMemberId(),
    ).resolves.toBe(ORGANIZER_ID);
  });

  it('bootstrap: refuses when neither is set', async () => {
    Configuration.meetup.organizerMemberId = '';
    await expect(
      organizerLoginDeps(() => client).expectedMemberId(),
    ).resolves.toBeUndefined();
  });

  it('saves tokens, member id and episode close in one locked transaction, then alerts and re-arms the helper', async () => {
    db.failing = true;
    await organizerLoginDeps(() => client).saveRenewedCredential(
      TOKENS,
      ORGANIZER_ID,
    );

    expect(events).toEqual([
      `lock ${KEY}`,
      'write',
      `setMemberId ${ORGANIZER_ID}`,
      'clearFailing',
      'commit',
      'alert',
      'note',
    ]);
    expect(locked.write).toHaveBeenCalledWith(TOKENS);
    expect(logAlert).toHaveBeenCalledWith(client, ORGANIZER_RESTORED_ALERT);
    expect(ORGANIZER_RESTORED_ALERT.title).toBe(
      'Meetup organizer login restored',
    );
  });

  it('posts no recovery alert when no failure episode was open', async () => {
    await organizerLoginDeps(() => client).saveRenewedCredential(
      TOKENS,
      ORGANIZER_ID,
    );
    expect(logAlert).not.toHaveBeenCalled();
    expect(noteOrganizerCredentialRenewed).toHaveBeenCalledTimes(1);
  });

  it('refuses, inside the lock, to overwrite a different recorded account', async () => {
    db.meta = { memberId: '555', failingSince: null };
    await expect(
      organizerLoginDeps(() => client).saveRenewedCredential(
        TOKENS,
        ORGANIZER_ID,
      ),
    ).rejects.toBeInstanceOf(OrganizerAccountChangedError);
    expect(locked.write).not.toHaveBeenCalled();
    expect(locked.setMemberId).not.toHaveBeenCalled();
    expect(logAlert).not.toHaveBeenCalled();
    expect(noteOrganizerCredentialRenewed).not.toHaveBeenCalled();
  });

  it('without a credential store: no status, and saving fails', async () => {
    vi.mocked(ApplicationCredentialRepository).mockResolvedValue(undefined);
    const deps = organizerLoginDeps(() => client);
    await expect(deps.credentialStatus()).resolves.toBeUndefined();
    await expect(deps.expectedMemberId()).rejects.toThrow();
    await expect(
      deps.saveRenewedCredential(TOKENS, ORGANIZER_ID),
    ).rejects.toThrow();
  });

  it('audits to the moderation channel, and only with a client', async () => {
    const entry = { title: 't', description: 'd' };
    await organizerLoginDeps(() => client).audit(entry);
    expect(logModeration).toHaveBeenCalledWith(client, entry);

    vi.mocked(logModeration).mockClear();
    await expect(
      organizerLoginDeps(() => undefined).audit(entry),
    ).resolves.toBe(false);
    expect(logModeration).not.toHaveBeenCalled();
  });

  it('reads the member id of whoever signed in', async () => {
    fake.getSelfId.mockResolvedValueOnce(ORGANIZER_ID);
    await expect(
      organizerLoginDeps(() => client).fetchMeetupMemberId('ACCESS'),
    ).resolves.toBe(ORGANIZER_ID);

    fake.getSelfId.mockRejectedValueOnce(
      new Error('Meetup returned no usable member id'),
    );
    await expect(
      organizerLoginDeps(() => client).fetchMeetupMemberId('ACCESS'),
    ).rejects.toThrow();
  });
});

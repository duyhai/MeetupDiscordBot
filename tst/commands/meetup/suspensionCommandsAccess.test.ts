/* eslint-disable @typescript-eslint/unbound-method -- vi.mocked on the static instance(), as unlinkAccount.test.ts */
import { Attachment, CommandInteraction } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetupListSuspensionsCommands } from '../../../src/commands/meetup/listSuspensions.js';
import { MeetupRecordSuspensionCommands } from '../../../src/commands/meetup/recordSuspension.js';
import { MeetupVoidSuspensionCommands } from '../../../src/commands/meetup/voidSuspension.js';
import { SERVER_ROLES } from '../../../src/constants.js';
import { PostgresSuspensionRepository } from '../../../src/lib/repositories/postgresSuspensionRepository.js';

// The real role check runs; only the wrapper is straight-through, so a
// refusal surfaces as a rejection here (in production the wrapper turns it
// into the standard error reply).
vi.mock('../../../src/util/discord.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/util/discord.js')>();
  return {
    ...actual,
    discordCommandWrapper: vi.fn(async (_interaction, fn: () => unknown) => {
      await fn();
    }),
    logModerationAction: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock(
  '../../../src/lib/repositories/postgresSuspensionRepository.js',
  () => ({
    PostgresSuspensionRepository: { instance: vi.fn() },
  }),
);
vi.mock('../../../src/util/meetup.js', () => ({
  withMeetupClient: vi.fn().mockResolvedValue(undefined),
}));

/** Thrown by the first step past the gate, so a pass never reaches a real write. */
const PAST_THE_GATE = 'past the gate';

type Who =
  | 'a leader'
  | 'a moderator'
  | 'an organizer'
  | 'an admin'
  | 'an admin who leads';

function interactionFor(who: Who): CommandInteraction {
  const roleIds = new Set<string>(
    {
      'a leader': [SERVER_ROLES.leadership],
      'a moderator': [SERVER_ROLES.moderator],
      'an organizer': [SERVER_ROLES.organizer],
      // The Admin role carries the Administrator permission, but is not Leadership.
      'an admin': [],
      'an admin who leads': [SERVER_ROLES.leadership],
    }[who],
  );
  const administrator = who === 'an admin' || who === 'an admin who leads';
  const member = {
    roles: { cache: { has: (id: string) => roleIds.has(id) } },
    permissions: { has: vi.fn().mockReturnValue(administrator) },
  };
  return {
    user: { id: '100000000000000001', username: who },
    guild: { members: { fetch: vi.fn().mockResolvedValue(member) } },
  } as unknown as CommandInteraction;
}

const record = (who: Who) =>
  new MeetupRecordSuspensionCommands().recordSuspensionHandler(
    {
      url: 'https://cdn.example.invalid/s.csv',
      name: 's.csv',
    } as Attachment,
    interactionFor(who),
  );
const voidOne = (who: Who) =>
  new MeetupVoidSuspensionCommands().voidSuspensionHandler(
    7,
    'wrong member',
    interactionFor(who),
  );

const RECORD_REFUSAL = 'Only the 1.5 Leadership Team can record suspensions.';
const VOID_REFUSAL = 'Only the 1.5 Leadership Team can void suspensions.';

describe('/meetup_record_suspension and /meetup_void_suspension: 1.5 Leadership Team only', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockRejectedValue(new Error(PAST_THE_GATE));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(PostgresSuspensionRepository.instance).mockRejectedValue(
      new Error(PAST_THE_GATE),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['a moderator', 'an organizer', 'an admin'] as const)(
    'refuses %s without the Leadership role before reading anything',
    async (who) => {
      await expect(record(who)).rejects.toThrow(RECORD_REFUSAL);
      await expect(voidOne(who)).rejects.toThrow(VOID_REFUSAL);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(PostgresSuspensionRepository.instance).not.toHaveBeenCalled();
    },
  );

  it.each(['a leader', 'an admin who leads'] as const)(
    'lets %s through to the work',
    async (who) => {
      await expect(record(who)).rejects.toThrow(PAST_THE_GATE);
      expect(fetchMock).toHaveBeenCalledOnce();
      await expect(voidOne(who)).rejects.toThrow(PAST_THE_GATE);
      expect(PostgresSuspensionRepository.instance).toHaveBeenCalledOnce();
    },
  );

  it('other commands still admit an Admin without a staff role', async () => {
    await expect(
      new MeetupListSuspensionsCommands().listSuspensionsHandler(
        interactionFor('an admin'),
      ),
    ).rejects.toThrow(PAST_THE_GATE);
    expect(PostgresSuspensionRepository.instance).toHaveBeenCalledOnce();
  });
});

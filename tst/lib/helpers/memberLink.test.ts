/* eslint-disable @typescript-eslint/no-explicit-any */
import { CommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as discordLogger from '../../../src/lib/helpers/discordLogger.js';
import {
  DuplicateMeetupAccountError,
  recordManualOnboard,
  recordMeetupLink,
} from '../../../src/lib/helpers/memberLink.js';
import { InMemoryMemberRepository } from '../../../src/lib/repositories/inMemoryMemberRepository.js';
import * as memberRepository from '../../../src/util/memberRepository.js';

vi.mock('../../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/util/memberRepository.js', () => ({
  ApplicationMemberRepository: vi.fn(),
}));

const info = {
  meetupId: 'meetup-1',
  meetupName: 'Test User',
  meetupMemberUrl: 'https://www.meetup.com/members/1/',
};

function makeInteraction(userId = 'discord-1') {
  return {
    client: {},
    user: { id: userId, username: 'testUser', toString: () => `<@${userId}>` },
  } as unknown as CommandInteraction;
}

describe('recordMeetupLink', () => {
  let repo: InMemoryMemberRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new InMemoryMemberRepository();
    vi.mocked(memberRepository.ApplicationMemberRepository).mockResolvedValue(
      repo,
    );
  });

  it('stores a new link and logs activity', async () => {
    await recordMeetupLink(makeInteraction(), info, 'self_onboard');

    const row = await repo.findByDiscordId('discord-1');
    expect(row).toMatchObject({
      meetupId: 'meetup-1',
      meetupName: 'Test User',
      onboardMethod: 'self_onboard',
    });
    expect(vi.mocked(discordLogger.logActivity)).toHaveBeenCalled();
    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
  });

  it('blocks when the Meetup account is linked to another Discord user', async () => {
    await recordMeetupLink(makeInteraction('discord-1'), info, 'self_onboard');

    await expect(
      recordMeetupLink(makeInteraction('discord-2'), info, 'sync_v2'),
    ).rejects.toThrow(DuplicateMeetupAccountError);

    expect(await repo.findByDiscordId('discord-2')).toBeUndefined();
    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
  });

  it('blocks a concurrent duplicate link that slips past the pre-check', async () => {
    await recordMeetupLink(makeInteraction('discord-1'), info, 'self_onboard');
    // Simulate the check-then-write race: the pre-check misses the row that
    // the repository's unique constraint will still reject.
    vi.spyOn(repo, 'findByMeetupId').mockResolvedValue(undefined);

    await expect(
      recordMeetupLink(makeInteraction('discord-2'), info, 'sync_v2'),
    ).rejects.toThrow(DuplicateMeetupAccountError);

    expect(await repo.findByDiscordId('discord-2')).toBeUndefined();
    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
    const [, entry] = vi.mocked(discordLogger.logAlert).mock.calls[0];
    expect(entry.title).toContain('Duplicate Meetup link blocked');
  });

  it('alerts (but allows) when a user switches Meetup accounts', async () => {
    await recordMeetupLink(makeInteraction(), info, 'self_onboard');
    await recordMeetupLink(
      makeInteraction(),
      { ...info, meetupId: 'meetup-2' },
      'self_onboard',
    );

    expect((await repo.findByDiscordId('discord-1'))?.meetupId).toBe(
      'meetup-2',
    );
    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
  });

  it('re-sync of the same account is activity only', async () => {
    await recordMeetupLink(makeInteraction(), info, 'self_onboard');
    await recordMeetupLink(makeInteraction(), info, 'self_onboard');

    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
    expect(vi.mocked(discordLogger.logActivity)).toHaveBeenCalledTimes(2);
  });

  it('swallows repository failures and alerts instead of throwing', async () => {
    vi.mocked(memberRepository.ApplicationMemberRepository).mockRejectedValue(
      new Error('db down'),
    );

    await expect(
      recordMeetupLink(makeInteraction(), info, 'self_onboard'),
    ).resolves.toBeUndefined();
    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
  });
});

describe('recordManualOnboard', () => {
  let repo: InMemoryMemberRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new InMemoryMemberRepository();
    vi.mocked(memberRepository.ApplicationMemberRepository).mockResolvedValue(
      repo,
    );
  });

  it('records a null-meetup row and alerts (deprecated flow)', async () => {
    await recordManualOnboard(makeInteraction('mod-1'), 'target-1');

    const row = await repo.findByDiscordId('target-1');
    expect(row).toMatchObject({
      meetupId: null,
      onboardMethod: 'manual',
      onboardedBy: 'mod-1',
    });
    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite an existing linked row', async () => {
    await recordMeetupLink(makeInteraction('target-1'), info, 'self_onboard');
    vi.clearAllMocks();
    vi.mocked(memberRepository.ApplicationMemberRepository).mockResolvedValue(
      repo,
    );

    await recordManualOnboard(makeInteraction('mod-1'), 'target-1');

    expect((await repo.findByDiscordId('target-1'))?.meetupId).toBe('meetup-1');
  });

  it('never throws on repository failure', async () => {
    vi.mocked(memberRepository.ApplicationMemberRepository).mockRejectedValue(
      new Error('db down'),
    );
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      recordManualOnboard(makeInteraction('mod-1') as any, 'target-1'),
    ).resolves.toBeUndefined();
    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
  });
});

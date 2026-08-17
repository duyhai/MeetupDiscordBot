import { GuildMember } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  recordIdentityFor,
  updateBaselineSilently,
} from '../../../src/lib/helpers/identityMonitor.js';

const repo = {
  getSnapshot: vi.fn(),
  putSnapshot: vi.fn().mockResolvedValue(undefined),
  recordChanges: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../../src/util/identityRepository.js', () => ({
  ApplicationIdentityRepository: vi.fn(async () => repo),
}));

vi.mock('../../../src/lib/helpers/identityThumbs.js', () => ({
  fetchChangeThumbs: vi.fn(async () => new Map()),
}));

function fakeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    nickname: 'Some One',
    avatar: null,
    guild: { id: 'g1' },
    user: {
      username: 'someone',
      globalName: 'Someone',
      avatar: 'aaa',
      bot: false,
    },
    ...overrides,
  } as unknown as GuildMember;
}

describe('recordIdentityFor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.getSnapshot.mockResolvedValue({
      discordUserId: 'u1',
      username: 'someone',
      globalName: 'Someone',
      nickname: 'Some One',
      userAvatarHash: 'aaa',
      memberAvatarHash: null,
    });
  });

  it('records nothing and writes no baseline when nothing changed', async () => {
    const changes = await recordIdentityFor(fakeMember(), 'event');

    expect(changes).toEqual([]);
    expect(repo.recordChanges).not.toHaveBeenCalled();
    // An unchanged member must not cost a write; the sweep hits 2,008 of them.
    expect(repo.putSnapshot).not.toHaveBeenCalled();
  });

  it('records the change and advances the baseline', async () => {
    const member = fakeMember({
      user: {
        username: 'someone',
        globalName: 'Someone',
        avatar: 'bbb',
        bot: false,
      },
    });

    const changes = await recordIdentityFor(member, 'event');

    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('user_avatar');
    expect(repo.recordChanges).toHaveBeenCalledTimes(1);
    // Baseline must advance, or the same change re-reports on every sweep.
    expect(repo.putSnapshot).toHaveBeenCalledTimes(1);
  });

  it('writes a baseline but no change for a first sighting', async () => {
    repo.getSnapshot.mockResolvedValue(undefined);

    const changes = await recordIdentityFor(fakeMember(), 'backfill');

    expect(changes).toEqual([]);
    expect(repo.recordChanges).not.toHaveBeenCalled();
    // Backfill must persist the baseline, else day one reports 2,008 changes.
    expect(repo.putSnapshot).toHaveBeenCalledTimes(1);
  });

  it('ignores bots entirely', async () => {
    const bot = fakeMember({
      user: { username: 'bot', globalName: null, avatar: 'x', bot: true },
    });

    await recordIdentityFor(bot, 'sweep');

    expect(repo.putSnapshot).not.toHaveBeenCalled();
    expect(repo.recordChanges).not.toHaveBeenCalled();
  });
});

describe('updateBaselineSilently', () => {
  beforeEach(() => vi.clearAllMocks());

  it('advances the baseline without recording a change', async () => {
    await updateBaselineSilently(fakeMember());

    // The bot sets nicknames during onboarding; without this its own writes
    // would show up in the digest as suspicious name changes.
    expect(repo.putSnapshot).toHaveBeenCalledTimes(1);
    expect(repo.recordChanges).not.toHaveBeenCalled();
  });
});

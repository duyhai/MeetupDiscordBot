import { Client } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as discordLogger from '../../../src/lib/helpers/discordLogger.js';
import {
  collectUnlinkedMemberIds,
  formatUnlinkedDigest,
  runDigestOnce,
  shouldRunDigestNow,
} from '../../../src/lib/helpers/unlinkedDigest.js';
import { MemberRecord } from '../../../src/lib/repositories/types.js';
import * as cache from '../../../src/util/cache.js';
import * as memberRepository from '../../../src/util/memberRepository.js';

vi.mock('../../../src/lib/helpers/discordLogger.js', () => ({
  logAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/util/cache.js', () => ({
  ApplicationCache: vi.fn(),
}));
vi.mock('../../../src/util/memberRepository.js', () => ({
  ApplicationMemberRepository: vi.fn(),
}));

const linkedRow = (discordUserId: string): MemberRecord => ({
  discordUserId,
  meetupId: `meetup-${discordUserId}`,
  meetupName: 'x',
  meetupMemberUrl: 'x',
  onboardMethod: 'self_onboard',
  onboardedBy: null,
  firstOnboardedAt: new Date(),
  lastSyncedAt: new Date(),
});

const manualRow = (discordUserId: string): MemberRecord => ({
  ...linkedRow(discordUserId),
  meetupId: null,
  onboardMethod: 'manual',
});

describe('shouldRunDigestNow', () => {
  it('fires only during the 17:00 UTC hour', () => {
    expect(shouldRunDigestNow(new Date('2026-08-14T17:30:00Z'))).toBe(true);
    expect(shouldRunDigestNow(new Date('2026-08-14T16:59:00Z'))).toBe(false);
    expect(shouldRunDigestNow(new Date('2026-08-14T18:00:00Z'))).toBe(false);
  });
});

describe('collectUnlinkedMemberIds', () => {
  it('flags verified humans with no row or a null-meetup row', () => {
    const members = [
      { id: 'linked', isBot: false, hasOnboardingRole: false },
      { id: 'norow', isBot: false, hasOnboardingRole: false },
      { id: 'manual', isBot: false, hasOnboardingRole: false },
      { id: 'bot', isBot: true, hasOnboardingRole: false },
      { id: 'newbie', isBot: false, hasOnboardingRole: true },
    ];
    const rows = [linkedRow('linked'), manualRow('manual')];

    expect(collectUnlinkedMemberIds(members, rows)).toEqual([
      'norow',
      'manual',
    ]);
  });
});

describe('runDigestOnce', () => {
  const unlinkedMember = {
    id: 'unlinked-1',
    user: { bot: false },
    roles: { cache: { has: () => false } },
  };

  function makeClient(membersFetch: () => Promise<(typeof unlinkedMember)[]>) {
    const guild = {
      members: { fetch: vi.fn().mockImplementation(membersFetch) },
    };
    return {
      guilds: {
        fetch: vi.fn().mockImplementation((guildId?: string) => {
          return guildId
            ? Promise.resolve(guild)
            : Promise.resolve({ first: () => ({ id: 'guild-1' }) });
        }),
      },
    } as unknown as Client;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    const claimedKeys = new Set<string>();
    vi.mocked(cache.ApplicationCache).mockResolvedValue({
      exclusive_set: async (key: string) => {
        if (claimedKeys.has(key)) {
          return false;
        }
        claimedKeys.add(key);
        return true;
      },
    } as Awaited<ReturnType<typeof cache.ApplicationCache>>);
    vi.mocked(memberRepository.ApplicationMemberRepository).mockResolvedValue({
      listAll: async () => [],
    } as unknown as Awaited<
      ReturnType<typeof memberRepository.ApplicationMemberRepository>
    >);
  });

  it('does not consume the daily claim when collection fails', async () => {
    const failingClient = makeClient(() =>
      Promise.reject(new Error('guild members unavailable')),
    );
    await expect(runDigestOnce(failingClient)).rejects.toThrow(
      'guild members unavailable',
    );

    const workingClient = makeClient(() => Promise.resolve([unlinkedMember]));
    await runDigestOnce(workingClient);

    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
  });

  it('posts at most once per day across restarts', async () => {
    const client = makeClient(() => Promise.resolve([unlinkedMember]));
    await runDigestOnce(client);
    await runDigestOnce(client);

    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
  });
});

describe('formatUnlinkedDigest', () => {
  it('returns undefined when everyone is linked', () => {
    expect(formatUnlinkedDigest([])).toBeUndefined();
  });

  it('lists members and caps at 50 with an overflow note', () => {
    const few = formatUnlinkedDigest(['a', 'b']);
    expect(few?.title).toContain('2');
    expect(few?.description).toContain('<@a>');
    expect(few?.description).toContain('<@b>');

    const ids = Array.from({ length: 120 }, (_, i) => `user-${i}`);
    const many = formatUnlinkedDigest(ids);
    expect(many?.title).toContain('120');
    expect(many?.description).toContain('<@user-49>');
    expect(many?.description).not.toContain('<@user-50>');
    expect(many?.description).toContain('…and 70 more');
  });
});

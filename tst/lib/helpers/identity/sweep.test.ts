import { Client } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GUILD_ID } from '../../../../src/constants.js';
import { runIdentitySweep } from '../../../../src/lib/helpers/identity/sweep.js';
import { recordIdentityFor } from '../../../../src/lib/helpers/identity/monitor.js';

vi.mock('../../../../src/lib/helpers/identity/monitor.js', () => ({
  recordIdentityFor: vi.fn().mockResolvedValue([]),
}));

function fakeClient(memberIds: string[]) {
  const members = new Map(
    memberIds.map((id) => [
      id,
      { id, user: { bot: false }, guild: { id: GUILD_ID } },
    ]),
  );
  return {
    guilds: {
      // The sweep resolves the configured guild directly by id.
      fetch: vi.fn().mockResolvedValue({
        id: GUILD_ID,
        members: { fetch: vi.fn().mockResolvedValue(members) },
      }),
    },
  } as unknown as Client;
}

/**
 * A client whose cache/lookup would hand back a different guild first if the
 * sweep ever went back to guilds.first() -- each guild's member list is
 * distinguishable by which guild it belongs to.
 */
function fakeClientWithGuilds(guildIds: string[]) {
  const guildsById = new Map(
    guildIds.map((id) => [
      id,
      {
        id,
        members: {
          fetch: vi.fn().mockResolvedValue(
            new Map([
              [
                `member-of-${id}`,
                {
                  id: `member-of-${id}`,
                  user: { bot: false },
                  guild: { id },
                },
              ],
            ]),
          ),
        },
      },
    ]),
  );
  return {
    guilds: {
      fetch: vi.fn((id: string) => Promise.resolve(guildsById.get(id))),
    },
  } as unknown as Client;
}

describe('runIdentitySweep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records every member in the guild', async () => {
    const result = await runIdentitySweep(fakeClient(['a', 'b', 'c']), 'sweep');

    expect(recordIdentityFor).toHaveBeenCalledTimes(3);
    expect(result.scanned).toBe(3);
  });

  it('passes the requested source through', async () => {
    await runIdentitySweep(fakeClient(['a']), 'backfill');

    // Backfill must be distinguishable from sweep in the change log.
    expect(vi.mocked(recordIdentityFor).mock.calls[0][1]).toBe('backfill');
  });

  it('counts only members that actually changed', async () => {
    vi.mocked(recordIdentityFor)
      .mockResolvedValueOnce([
        {
          platform: 'discord',
          scopeId: GUILD_ID,
          subjectId: 'a',
          field: 'nickname',
          oldValue: 'A',
          newValue: 'B',
        },
      ])
      .mockResolvedValue([]);

    const result = await runIdentitySweep(fakeClient(['a', 'b']), 'sweep');

    expect(result.changed).toBe(1);
  });

  it('continues past a member that throws', async () => {
    vi.mocked(recordIdentityFor)
      .mockRejectedValueOnce(new Error('one bad member'))
      .mockResolvedValue([]);

    const result = await runIdentitySweep(fakeClient(['a', 'b']), 'sweep');

    // One failure must not abandon the remaining 2,000 members.
    expect(result.scanned).toBe(2);
  });

  it('sweeps the configured guild, not whichever is first in cache', async () => {
    const client = fakeClientWithGuilds(['other-guild', GUILD_ID]);

    await runIdentitySweep(client, 'sweep');

    // guilds.first() is insertion-ordered and effectively arbitrary. Sweeping
    // the wrong guild would diff one guild's members against another guild's
    // baselines and report every nickname as changed.
    expect(vi.mocked(recordIdentityFor).mock.calls[0][0].guild.id).toBe(
      GUILD_ID,
    );
  });
});

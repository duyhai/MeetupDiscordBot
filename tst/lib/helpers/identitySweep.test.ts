import { Client, Collection } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runIdentitySweep } from '../../../src/lib/helpers/identitySweep.js';
import { recordIdentityFor } from '../../../src/lib/helpers/identityMonitor.js';

vi.mock('../../../src/lib/helpers/identityMonitor.js', () => ({
  recordIdentityFor: vi.fn().mockResolvedValue([]),
}));

function fakeClient(memberIds: string[]) {
  const members = new Map(
    memberIds.map((id) => [
      id,
      { id, user: { bot: false }, guild: { id: 'g1' } },
    ]),
  );
  return {
    guilds: {
      // client.guilds.fetch() returns a discord.js Collection (it has
      // .first()), not a plain Map, so the fake must match that shape.
      fetch: vi
        .fn()
        .mockResolvedValueOnce(new Collection([['g1', { id: 'g1' }]]))
        .mockResolvedValue({
          id: 'g1',
          members: { fetch: vi.fn().mockResolvedValue(members) },
        }),
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
          discordUserId: 'a',
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
});

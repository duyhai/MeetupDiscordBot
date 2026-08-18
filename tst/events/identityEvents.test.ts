import { Client, GuildMember } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GUILD_ID } from '../../src/constants.js';
import { registerIdentityEvents } from '../../src/events/identityEvents.js';
import { recordIdentityFor } from '../../src/lib/helpers/identity/monitor.js';

vi.mock('../../src/lib/helpers/identity/monitor.js', () => ({
  recordIdentityFor: vi.fn().mockResolvedValue([]),
}));

const member = (id: string, guildId = 'g1') =>
  ({
    id,
    user: { bot: false },
    guild: { id: guildId },
  }) as unknown as GuildMember;

/**
 * `guildIds` seeds client.guilds.cache with one guild per id, each already
 * holding a cached member 'u1' -- so a handler that iterates the whole cache
 * instead of resolving GUILD_ID would find (and record) more than one.
 */
function fakeClient(guildIds: string[] = []) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const cache = new Map(
    guildIds.map((id) => [
      id,
      { members: { cache: new Map([['u1', member('u1', id)]]) } },
    ]),
  );
  const client = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    }),
    guilds: { cache },
  } as unknown as Client;
  return { client, handlers };
}

describe('registerIdentityEvents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('subscribes to guildMemberUpdate', () => {
    const { client, handlers } = fakeClient();

    registerIdentityEvents(client);

    // Guards the CALL SITE: a previous release shipped a correct helper that
    // nothing invoked, and only a wiring assertion catches that.
    expect(handlers.has('guildMemberUpdate')).toBe(true);
  });

  it('records the updated member on guildMemberUpdate', async () => {
    const { client, handlers } = fakeClient();
    registerIdentityEvents(client);

    await handlers.get('guildMemberUpdate')?.(member('old'), member('u1'));

    expect(recordIdentityFor).toHaveBeenCalledTimes(1);
    const [passed, source] = vi.mocked(recordIdentityFor).mock.calls[0];
    // Must record the AFTER member; recording the before re-saves the old state.
    expect(passed.id).toBe('u1');
    expect(source).toBe('event');
  });

  it('subscribes to userUpdate', () => {
    const { client, handlers } = fakeClient();

    registerIdentityEvents(client);

    // Global avatar changes arrive on userUpdate, not guildMemberUpdate.
    expect(handlers.has('userUpdate')).toBe(true);
  });

  it('records the cached guild member on userUpdate', async () => {
    const { client, handlers } = fakeClient([GUILD_ID]);
    registerIdentityEvents(client);

    await handlers.get('userUpdate')?.({ id: 'u1' }, { id: 'u1' });

    // Global avatar/username changes only ever arrive here, and only the
    // per-guild member carries the baseline to diff against.
    expect(recordIdentityFor).toHaveBeenCalledTimes(1);
  });

  it('records only the configured guild on userUpdate', async () => {
    const { client, handlers } = fakeClient(['other-guild', GUILD_ID]);
    registerIdentityEvents(client);

    await handlers.get('userUpdate')?.({ id: 'u1' }, { id: 'u1' });

    // Recording every cached guild writes two guilds' per-guild facts against
    // one member and produces permanent false nickname alerts.
    expect(recordIdentityFor).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordIdentityFor).mock.calls[0][0].guild.id).toBe(
      GUILD_ID,
    );
  });

  it('records nothing when the member is not in the guild cache', async () => {
    const { client, handlers } = fakeClient();
    registerIdentityEvents(client);

    await handlers.get('userUpdate')?.(
      { id: 'u-uncached' },
      {
        id: 'u-uncached',
      },
    );

    expect(recordIdentityFor).not.toHaveBeenCalled();
  });

  it('survives a handler error without crashing the process', async () => {
    vi.mocked(recordIdentityFor).mockRejectedValueOnce(new Error('db down'));
    const { client, handlers } = fakeClient();
    registerIdentityEvents(client);

    // An unhandled rejection in a gateway listener takes down the dyno.
    await expect(
      handlers.get('guildMemberUpdate')?.(member('old'), member('u1')),
    ).resolves.not.toThrow();
  });
});

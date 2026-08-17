import { Client, GuildMember } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerIdentityEvents } from '../../src/events/identityEvents.js';
import { recordIdentityFor } from '../../src/lib/helpers/identityMonitor.js';

vi.mock('../../src/lib/helpers/identityMonitor.js', () => ({
  recordIdentityFor: vi.fn().mockResolvedValue([]),
}));

function fakeClient() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const client = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    }),
    guilds: { cache: new Map() },
  } as unknown as Client;
  return { client, handlers };
}

const member = (id: string) =>
  ({ id, user: { bot: false }, guild: { id: 'g1' } }) as unknown as GuildMember;

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

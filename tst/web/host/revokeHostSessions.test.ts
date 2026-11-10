import { describe, expect, it, vi } from 'vitest';

import { revokeHostSessions } from '../../../src/web/host/hostServices.js';
import {
  HOST_SESSION_OPTIONS,
  HostSession,
} from '../../../src/web/host/hostSession.js';
import { SessionStore } from '../../../src/web/session.js';
import { ApplicationCache } from '../../../src/util/cache.js';
import { FakeCache } from '../fakeCache.js';

vi.mock('../../../src/util/cache.js', () => ({ ApplicationCache: vi.fn() }));

describe('revokeHostSessions', () => {
  it('ends the member’s host sessions on the host store, and no one else’s', async () => {
    const cache = new FakeCache();
    vi.mocked(ApplicationCache).mockResolvedValue(cache as never);
    const store = new SessionStore<HostSession>(
      cache,
      Date.now,
      HOST_SESSION_OPTIONS,
    );
    const user = (userId: string) => ({
      userId,
      username: 'Ann',
      discordUserId: null,
      tier: 'regular' as const,
      via: 'meetup' as const,
    });
    const { session: promoted } = await store.create(user('4242'));
    const { session: other } = await store.create(user('5151'));
    await revokeHostSessions('4242');
    await expect(store.isRevoked(promoted)).resolves.toBe(true);
    await expect(store.isRevoked(other)).resolves.toBe(false);
    // The host store's own mark, not the staff dashboard's.
    expect(
      await cache.get(`${HOST_SESSION_OPTIONS.validAfterPrefix}4242`),
    ).toBeDefined();
  });

  it('refuses an id that cannot be a Meetup member id', async () => {
    vi.mocked(ApplicationCache).mockResolvedValue(new FakeCache() as never);
    await expect(revokeHostSessions('not-an-id')).rejects.toThrow(RangeError);
  });
});

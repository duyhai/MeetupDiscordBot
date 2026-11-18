import { describe, expect, it, vi } from 'vitest';

import { SERVER_ROLES } from '../../../src/constants.js';
import { resolveHost } from '../../../src/lib/hosts/eligibility.js';
import {
  hostRoleChecks,
  sharedRoleReads,
} from '../../../src/web/host/hostRoles.js';

const A = '100000000000000001';
const B = '100000000000000002';

describe('sharedRoleReads', () => {
  it('one read serves both lookups of a resolve, per member', async () => {
    const fetchRoles = vi.fn(async (id: string) => {
      return id === A ? [SERVER_ROLES.guest_host, SERVER_ROLES.organizer] : [];
    });
    const checks = hostRoleChecks(sharedRoleReads(fetchRoles, 5_000, () => 0));
    const resolution = await resolveHost(
      {
        discordIdForMeetup: async () => undefined,
        meetupIdForDiscord: async () => '4242',
        pastHostedCount: async () => 0,
        isPromoted: async () => false,
        ...checks,
      },
      { discordUserId: A },
    );
    expect(resolution).toMatchObject({
      kind: 'host',
      staffRoles: ['organizer'],
    });
    expect(fetchRoles).toHaveBeenCalledTimes(1);
    await checks.hasGuestHostRole(B);
    expect(fetchRoles.mock.calls.map(([id]) => id)).toEqual([A, B]);
  });

  it('reads again once the reuse window has passed', async () => {
    let t = 0;
    const fetchRoles = vi.fn(async () => [SERVER_ROLES.leadership]);
    const rolesOf = sharedRoleReads(fetchRoles, 5_000, () => t);
    await rolesOf(A);
    t = 4_999;
    await rolesOf(A);
    t = 5_000;
    await rolesOf(A);
    expect(fetchRoles).toHaveBeenCalledTimes(2);
  });

  it('a failed read is dropped, and only that one: a newer read for the member stays', async () => {
    let t = 0;
    let rejectOld: (e: Error) => void = () => undefined;
    const fetchRoles = vi
      .fn<(id: string) => Promise<string[]>>()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValue([SERVER_ROLES.organizer]);
    const rolesOf = sharedRoleReads(fetchRoles, 5_000, () => t);
    const old = rolesOf(A);
    t = 6_000; // the old entry has expired; a newer read replaces it
    await expect(rolesOf(A)).resolves.toEqual([SERVER_ROLES.organizer]);
    rejectOld(new Error('discord down'));
    await expect(old).rejects.toThrow('discord down');
    await rolesOf(A); // still the newer read, not a third fetch
    expect(fetchRoles).toHaveBeenCalledTimes(2);
  });

  it('a rejected read is evicted, so the next ask reads again', async () => {
    const fetchRoles = vi
      .fn<(id: string) => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue([]);
    const rolesOf = sharedRoleReads(fetchRoles, 5_000, () => 0);
    await expect(rolesOf(A)).rejects.toThrow('down');
    await expect(rolesOf(A)).resolves.toEqual([]);
    expect(fetchRoles).toHaveBeenCalledTimes(2);
  });

  it('a failing role read gives no badge but still refuses nothing', async () => {
    const checks = hostRoleChecks(async () => {
      throw new Error('down');
    });
    const resolution = await resolveHost(
      {
        discordIdForMeetup: async () => undefined,
        meetupIdForDiscord: async () => '4242',
        hasGuestHostRole: async () => true,
        pastHostedCount: async () => 0,
        isPromoted: async () => false,
        staffRoles: checks.staffRoles,
      },
      { discordUserId: A },
    );
    expect(resolution.kind).toBe('host');
    expect(resolution).not.toHaveProperty('staffRoles');
  });
});

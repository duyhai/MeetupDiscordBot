import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { GUILD_ID, SERVER_ROLES } from '../../src/constants.js';
import {
  DashboardUnavailableError,
  discordAccessCheck,
  hasDashboardRole,
} from '../../src/web/roleGate.js';

// Admin role: carries the Administrator permission, but is not a dashboard
// role. Hai decided (2026-10-15) that admins without Moderator or 1.5
// Leadership Team are refused.
const ADMIN_ROLE_ID = '912473408577609778';

const memberWith = (roleIds: string[], isAdministrator = false) => ({
  roles: { cache: new Map(roleIds.map((id) => [id, {}])) },
  permissions: { has: vi.fn().mockReturnValue(isAdministrator) },
});

const clientReturning = (fetchMember: ReturnType<typeof vi.fn>) => {
  const guildsFetch = vi.fn().mockResolvedValue({
    members: { fetch: fetchMember },
  });
  return { client: { guilds: { fetch: guildsFetch } }, guildsFetch };
};

const unknownMember = () =>
  new DiscordAPIError(
    { code: RESTJSONErrorCodes.UnknownMember, message: 'Unknown Member' },
    RESTJSONErrorCodes.UnknownMember,
    404,
    'GET',
    '/guilds/x/members/y',
    {},
  );

describe('hasDashboardRole', () => {
  it('admits moderators', () => {
    expect(hasDashboardRole([SERVER_ROLES.moderator])).toBe(true);
  });
  it('admits the 1.5 Leadership Team', () => {
    expect(hasDashboardRole([SERVER_ROLES.leadership])).toBe(true);
  });
  it('refuses Event Organizers without either role', () => {
    expect(hasDashboardRole([SERVER_ROLES.organizer])).toBe(false);
  });
  it('refuses no roles', () => {
    expect(hasDashboardRole([])).toBe(false);
  });
  it('refuses the Admin role on its own', () => {
    expect(hasDashboardRole([ADMIN_ROLE_ID])).toBe(false);
  });
});

describe('discordAccessCheck', () => {
  it('fetches the member fresh from the configured guild', async () => {
    const fetchMember = vi
      .fn()
      .mockResolvedValue(memberWith([SERVER_ROLES.moderator]));
    const { client, guildsFetch } = clientReturning(fetchMember);
    const check = discordAccessCheck(() => client as never);

    await expect(check('111111111111111111')).resolves.toBe(true);
    expect(guildsFetch).toHaveBeenCalledWith(GUILD_ID);
    expect(fetchMember).toHaveBeenCalledWith({
      user: '111111111111111111',
      force: true,
    });
  });

  it('denies a member without a dashboard role', async () => {
    const { client } = clientReturning(
      vi.fn().mockResolvedValue(memberWith([SERVER_ROLES.organizer])),
    );
    await expect(discordAccessCheck(() => client as never)('1')).resolves.toBe(
      false,
    );
  });

  it('refuses a member with only the Admin role and the Administrator permission', async () => {
    const { client } = clientReturning(
      vi.fn().mockResolvedValue(memberWith([ADMIN_ROLE_ID], true)),
    );
    await expect(discordAccessCheck(() => client as never)('1')).resolves.toBe(
      false,
    );
  });

  it('treats Unknown User as denied', async () => {
    const unknownUser = new DiscordAPIError(
      { code: RESTJSONErrorCodes.UnknownUser, message: 'Unknown User' },
      RESTJSONErrorCodes.UnknownUser,
      404,
      'GET',
      '/guilds/x/members/y',
      {},
    );
    const { client } = clientReturning(vi.fn().mockRejectedValue(unknownUser));
    await expect(discordAccessCheck(() => client as never)('1')).resolves.toBe(
      false,
    );
  });

  it('treats Unknown Member as denied', async () => {
    const { client } = clientReturning(
      vi.fn().mockRejectedValue(unknownMember()),
    );
    await expect(discordAccessCheck(() => client as never)('1')).resolves.toBe(
      false,
    );
  });

  it('propagates other Discord failures so callers fail closed with a retry', async () => {
    const { client } = clientReturning(
      vi.fn().mockRejectedValue(new Error('gateway down')),
    );
    await expect(
      discordAccessCheck(() => client as never)('1'),
    ).rejects.toThrow('gateway down');
  });

  it('is unavailable before the Discord client is ready', async () => {
    await expect(
      discordAccessCheck(() => undefined)('1'),
    ).rejects.toBeInstanceOf(DashboardUnavailableError);
  });
});

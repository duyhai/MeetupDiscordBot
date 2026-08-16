import { Guild } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REWARD_ROLES } from '../../../src/constants.js';
import { addRewardRole } from '../../../src/lib/helpers/onboardUser.js';

// A member with zero hosted (or attended) events produces `undefined` from
// `levels.find(...)`. Passing that through to `guild.roles.fetch(undefined)`
// makes discord.js GET *every* role in the guild and hand the whole
// Collection to `roles.add`, which PATCHes the member with all of them --
// including @everyone and privileged roles -- and Discord rejects it with
// DiscordAPIError[50013] Missing Permissions.
function makeGuild() {
  const rolesAdd = vi.fn();
  const rolesFetch = vi.fn(async (id?: string) => {
    if (!id) {
      // Mirror discord.js: a falsy id resolves to a Collection of all roles.
      return new Map([['all-roles', {}]]);
    }
    return { id };
  });
  const guild = {
    members: {
      fetch: vi.fn(async () => ({ roles: { add: rolesAdd, remove: vi.fn() } })),
    },
    roles: { fetch: rolesFetch },
  } as unknown as Guild;
  return { guild, rolesAdd, rolesFetch };
}

describe('addRewardRole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('awards the role for a real level', async () => {
    const { guild, rolesAdd, rolesFetch } = makeGuild();

    await addRewardRole(guild, 'discord-1', 'hosting', 5);

    expect(rolesFetch).toHaveBeenCalledWith(REWARD_ROLES.hosting[5]);
    expect(rolesAdd).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the member has not earned a level yet', async () => {
    const { guild, rolesAdd, rolesFetch } = makeGuild();

    await addRewardRole(guild, 'discord-1', 'hosting', undefined);

    // Must never fetch with a falsy id -- that returns every guild role.
    expect(rolesFetch).not.toHaveBeenCalled();
    expect(rolesAdd).not.toHaveBeenCalled();
  });

  it('does nothing when the level maps to no configured role', async () => {
    const { guild, rolesAdd, rolesFetch } = makeGuild();

    await addRewardRole(guild, 'discord-1', 'hosting', 999 as never);

    expect(rolesFetch).not.toHaveBeenCalled();
    expect(rolesAdd).not.toHaveBeenCalled();
  });
});

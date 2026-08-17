import { Guild } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REWARD_ROLES } from '../../../src/constants.js';
import { syncRewardRoles } from '../../../src/lib/helpers/onboardUser.js';

/**
 * Guards the REQUEST COUNT, not just the final role set.
 *
 * The previous implementation removed all six levels of both categories
 * unconditionally, then re-added the earned ones: 12 DELETEs plus up to 2 PUTs
 * per verification, whether or not anything had changed. discord.js issues one
 * REST call per role for the single-role branch and they share a rate-limit
 * bucket, so they queue serially -- 9s of a ~11s verification, measured in
 * production on 2026-08-16. Asserting only the resulting roles would let that
 * regress silently, so every test here also pins how many calls it took.
 */
const ORGANIZER = 'role-organizer';
const EVERYONE = 'role-everyone';

function makeGuild(currentRoleIds: string[]) {
  const rolesSet = vi.fn().mockResolvedValue(undefined);
  const rolesAdd = vi.fn().mockResolvedValue(undefined);
  const rolesRemove = vi.fn().mockResolvedValue(undefined);
  const rolesFetch = vi.fn(async (id?: string) => {
    if (!id) {
      // Mirror discord.js: a falsy id resolves to a Collection of all roles.
      return new Map([['all-roles', {}]]);
    }
    return { id };
  });
  const member = {
    roles: {
      cache: new Map(currentRoleIds.map((id) => [id, { id }])),
      set: rolesSet,
      add: rolesAdd,
      remove: rolesRemove,
    },
  };
  const guild = {
    members: { fetch: vi.fn(async () => member) },
    roles: { fetch: rolesFetch },
  } as unknown as Guild;
  return { guild, rolesSet, rolesAdd, rolesRemove, rolesFetch };
}

/** The role ids handed to the single `set` call, order-insensitively. */
function setPayload(rolesSet: ReturnType<typeof vi.fn>): string[] {
  const [roles] = rolesSet.mock.calls[0] as [Iterable<string>];
  return [...roles].sort();
}

describe('syncRewardRoles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('makes no request when the member already holds exactly the earned roles', async () => {
    const { guild, rolesSet, rolesAdd, rolesRemove } = makeGuild([
      EVERYONE,
      REWARD_ROLES.hosting[100],
      REWARD_ROLES.attendance[100],
    ]);

    await syncRewardRoles(guild, 'discord-1', {
      hosting: 100,
      attendance: 100,
    });

    // The common case: a member re-verifying with unchanged badges. This used
    // to cost 14 calls.
    expect(rolesSet).not.toHaveBeenCalled();
    expect(rolesAdd).not.toHaveBeenCalled();
    expect(rolesRemove).not.toHaveBeenCalled();
  });

  it('applies a level-up in a single call', async () => {
    const { guild, rolesSet, rolesAdd, rolesRemove } = makeGuild([
      EVERYONE,
      REWARD_ROLES.attendance[50],
    ]);

    await syncRewardRoles(guild, 'discord-1', { attendance: 100 });

    expect(rolesSet).toHaveBeenCalledTimes(1);
    expect(rolesAdd).not.toHaveBeenCalled();
    expect(rolesRemove).not.toHaveBeenCalled();
    expect(setPayload(rolesSet)).toEqual(
      [EVERYONE, REWARD_ROLES.attendance[100]].sort(),
    );
  });

  it('keeps roles it does not manage', async () => {
    const { guild, rolesSet } = makeGuild([
      EVERYONE,
      ORGANIZER,
      REWARD_ROLES.attendance[5],
    ]);

    await syncRewardRoles(guild, 'discord-1', { attendance: 20 });

    // Organizer and @everyone are not reward roles; stripping them would
    // silently demote moderators.
    expect(setPayload(rolesSet)).toEqual(
      [EVERYONE, ORGANIZER, REWARD_ROLES.attendance[20]].sort(),
    );
  });

  it('leaves categories that were not requested alone', async () => {
    const { guild, rolesSet } = makeGuild([
      EVERYONE,
      REWARD_ROLES.discord[50],
      REWARD_ROLES.hosting[5],
    ]);

    await syncRewardRoles(guild, 'discord-1', { hosting: 20 });

    // The retired Discord-linked badge is still on some members. Only the
    // categories passed in are ours to rewrite.
    expect(setPayload(rolesSet)).toEqual(
      [EVERYONE, REWARD_ROLES.discord[50], REWARD_ROLES.hosting[20]].sort(),
    );
  });

  it('strips the category when the member has not earned a level', async () => {
    const { guild, rolesSet } = makeGuild([EVERYONE, REWARD_ROLES.hosting[5]]);

    await syncRewardRoles(guild, 'discord-1', { hosting: undefined });

    // A member with zero hosted events yields `undefined` from
    // `levels.find(...)`. The payload must come out clean: an unfiltered
    // undefined reaching a role lookup is what produced
    // DiscordAPIError[50013] Missing Permissions in production.
    expect(setPayload(rolesSet)).toEqual([EVERYONE]);
  });

  it('makes no request when an unearned category is already absent', async () => {
    const { guild, rolesSet } = makeGuild([EVERYONE]);

    await syncRewardRoles(guild, 'discord-1', {
      hosting: undefined,
      attendance: undefined,
    });

    // A brand-new member with no badges: previously 12 no-op DELETEs.
    expect(rolesSet).not.toHaveBeenCalled();
  });

  it('clears a stale extra level in the same call', async () => {
    const { guild, rolesSet } = makeGuild([
      EVERYONE,
      REWARD_ROLES.hosting[5],
      REWARD_ROLES.hosting[20],
    ]);

    await syncRewardRoles(guild, 'discord-1', { hosting: 20 });

    // Only the earned level survives, and it still takes one call.
    expect(rolesSet).toHaveBeenCalledTimes(1);
    expect(setPayload(rolesSet)).toEqual(
      [EVERYONE, REWARD_ROLES.hosting[20]].sort(),
    );
  });
});

import { Client, Guild, Role } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { SERVER_ROLES } from '../../../src/constants.js';
import { logModeration } from '../../../src/lib/helpers/discordLogger.js';
import {
  ReverifyCandidate,
  formatReverifyProgress,
  moveToOnboardingIfStillUnlinked,
  selectEnforceTargets,
  selectReverifyTargets,
  startRoleJob,
  tagIfStillUnlinked,
} from '../../../src/lib/helpers/reverify.js';
import { InMemoryMemberRepository } from '../../../src/lib/repositories/inMemoryMemberRepository.js';
import { MemberRecord } from '../../../src/lib/repositories/types.js';

vi.mock('../../../src/lib/helpers/discordLogger.js', () => ({
  logModeration: vi.fn().mockResolvedValue(undefined),
}));

const REVERIFY_ROLE_ID = 'reverify-role';

function member(
  id: string,
  overrides: Partial<ReverifyCandidate> = {},
): ReverifyCandidate {
  return { id, isBot: false, isAdmin: false, roleIds: [], ...overrides };
}

function row(
  discordUserId: string,
  meetupId: string | null = `meetup-${discordUserId}`,
): MemberRecord {
  return {
    discordUserId,
    meetupId,
    meetupName: meetupId ? 'x' : null,
    meetupMemberUrl: meetupId ? 'x' : null,
    onboardMethod: meetupId ? 'self_onboard' : 'manual',
    onboardedBy: meetupId ? null : 'mod-1',
    firstOnboardedAt: new Date(),
    lastSyncedAt: new Date(),
  };
}

describe('selectReverifyTargets', () => {
  it('tags verified members with no record on file', () => {
    expect(
      selectReverifyTargets([member('a'), member('b')], [row('b')]),
    ).toEqual(['a']);
  });

  it('leaves out members a mod onboarded by hand', () => {
    // A mod vouched for them; they have a record but no Meetup ID.
    expect(
      selectReverifyTargets([member('manual')], [row('manual', null)]),
    ).toEqual([]);
  });

  it('never tags staff, bots, or people who are still onboarding', () => {
    const members = [
      member('admin', { isAdmin: true }),
      member('mod', { roleIds: [SERVER_ROLES.moderator] }),
      member('organizer', { roleIds: [SERVER_ROLES.organizer] }),
      member('bot', { isBot: true }),
      member('newbie', { roleIds: [SERVER_ROLES.onboarding] }),
      member('regular'),
    ];
    expect(selectReverifyTargets(members, [])).toEqual(['regular']);
  });
});

describe('selectEnforceTargets', () => {
  it('moves only members still holding Reverify', () => {
    const members = [
      member('tagged', { roleIds: [REVERIFY_ROLE_ID] }),
      member('untagged'),
    ];
    expect(selectEnforceTargets(members, [], REVERIFY_ROLE_ID)).toEqual([
      'tagged',
    ]);
  });

  it('skips a tagged member who linked after the role was given', () => {
    // The role is removed on link, but a failed removal must not cost a
    // linked member their access.
    const members = [member('linked', { roleIds: [REVERIFY_ROLE_ID] })];
    expect(
      selectEnforceTargets(members, [row('linked')], REVERIFY_ROLE_ID),
    ).toEqual([]);
  });

  it('never moves staff or bots, even if someone tagged them by hand', () => {
    const members = [
      member('admin', { isAdmin: true, roleIds: [REVERIFY_ROLE_ID] }),
      member('mod', {
        roleIds: [REVERIFY_ROLE_ID, SERVER_ROLES.moderator],
      }),
      member('bot', { isBot: true, roleIds: [REVERIFY_ROLE_ID] }),
    ];
    expect(selectEnforceTargets(members, [], REVERIFY_ROLE_ID)).toEqual([]);
  });

  it('includes members already in Onboarding, so they lose the tag too', () => {
    const members = [
      member('both', { roleIds: [REVERIFY_ROLE_ID, SERVER_ROLES.onboarding] }),
    ];
    expect(selectEnforceTargets(members, [], REVERIFY_ROLE_ID)).toEqual([
      'both',
    ]);
  });
});

describe('formatReverifyProgress', () => {
  it('reports how many still need to link and how many are linked', () => {
    const entry = formatReverifyProgress({ stillTagged: 312, linked: 210 });
    expect(entry.title).toBe('Reverify progress: 312 still need to link');
    expect(entry.description).toContain('210 members linked');
  });
});

describe('startRoleJob', () => {
  const client = {} as Client;

  async function settle() {
    await vi.waitFor(() => expect(logModeration).toHaveBeenCalled());
  }

  it('changes every member, keeps going past failures, and reports both', async () => {
    vi.mocked(logModeration).mockClear();
    const changed: string[] = [];

    const started = startRoleJob(
      client,
      'Reverify tagging',
      ['a', 'b', 'c'],
      async (id) => {
        if (id === 'b') {
          throw new Error('missing permissions');
        }
        changed.push(id);
        return true;
      },
    );
    await settle();

    expect(started).toBe(true);
    expect(changed).toEqual(['a', 'c']);
    const [, entry] = vi.mocked(logModeration).mock.calls[0];
    expect(entry.title).toBe('Reverify tagging finished: 2 of 3 members');
    expect(entry.description).toContain('<@b>');
  });

  it('reports members skipped by the re-check', async () => {
    vi.mocked(logModeration).mockClear();

    startRoleJob(client, 'Reverify enforcement', ['a', 'b'], async (id) => {
      return id === 'a';
    });
    await settle();

    const [, entry] = vi.mocked(logModeration).mock.calls[0];
    expect(entry.title).toBe('Reverify enforcement finished: 1 of 2 members');
    expect(entry.description).toContain('Skipped 1');
  });

  it('runs one job at a time, then frees up', async () => {
    vi.mocked(logModeration).mockClear();
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    expect(
      startRoleJob(client, 'first', ['a'], () => blocked.then(() => true)),
    ).toBe(true);
    expect(startRoleJob(client, 'second', ['b'], async () => true)).toBe(false);

    release();
    await settle();
    await vi.waitFor(() =>
      expect(startRoleJob(client, 'third', [], async () => true)).toBe(true),
    );
  });
});

/** A guild whose member fetch returns the member as it is right now. */
function fakeGuild(roleIds: string[], overrides: { bot?: boolean } = {}) {
  const roles = {
    cache: new Map(roleIds.map((id) => [id, {}])),
    add: vi.fn().mockResolvedValue(undefined),
    set: vi.fn<(roles: string[], reason: string) => Promise<void>>(),
  };
  const guildMember = {
    id: 'm1',
    user: { bot: overrides.bot ?? false },
    permissions: { has: () => false },
    roles,
  };
  const fetchMember = vi.fn().mockResolvedValue(guildMember);
  const guild = {
    id: 'guild-1',
    members: { fetch: fetchMember },
  } as unknown as Guild;
  return { guild, roles, fetchMember };
}

async function repoWith(...rows: MemberRecord[]) {
  const repo = new InMemoryMemberRepository();
  await Promise.all(rows.map((r) => repo.upsert(r)));
  return repo;
}

describe('tagIfStillUnlinked', () => {
  const reverifyRole = { id: REVERIFY_ROLE_ID } as Role;

  it('tags a member who is still unlinked', async () => {
    const { guild, roles, fetchMember } = fakeGuild(['guild-1']);

    expect(
      await tagIfStillUnlinked(guild, await repoWith(), reverifyRole, 'm1'),
    ).toBe(true);
    expect(roles.add).toHaveBeenCalledWith(reverifyRole, expect.any(String));
    expect(fetchMember).toHaveBeenCalledWith({
      user: 'm1',
      force: true,
    });
  });

  it('skips a member who linked after the job started', async () => {
    const { guild, roles } = fakeGuild(['guild-1']);

    expect(
      await tagIfStillUnlinked(
        guild,
        await repoWith(row('m1')),
        reverifyRole,
        'm1',
      ),
    ).toBe(false);
    expect(roles.add).not.toHaveBeenCalled();
  });
});

describe('moveToOnboardingIfStillUnlinked', () => {
  it('swaps Reverify for Onboarding in one call, keeping other roles', async () => {
    const { guild, roles } = fakeGuild(['guild-1', REVERIFY_ROLE_ID, 'lounge']);

    expect(
      await moveToOnboardingIfStillUnlinked(
        guild,
        await repoWith(),
        REVERIFY_ROLE_ID,
        'm1',
      ),
    ).toBe(true);
    expect(roles.set).toHaveBeenCalledTimes(1);
    const [newRoles] = roles.set.mock.calls[0];
    expect(newRoles.sort()).toEqual(['lounge', SERVER_ROLES.onboarding].sort());
  });

  it('drops the tag from someone already in Onboarding', async () => {
    const { guild, roles } = fakeGuild([
      REVERIFY_ROLE_ID,
      SERVER_ROLES.onboarding,
    ]);

    await moveToOnboardingIfStillUnlinked(
      guild,
      await repoWith(),
      REVERIFY_ROLE_ID,
      'm1',
    );
    expect(roles.set).toHaveBeenCalledWith(
      [SERVER_ROLES.onboarding],
      expect.any(String),
    );
  });

  it('skips a member who linked after the job started', async () => {
    // Linking removes Reverify, but the record is checked too in case that
    // removal failed.
    const { guild, roles } = fakeGuild([REVERIFY_ROLE_ID]);

    expect(
      await moveToOnboardingIfStillUnlinked(
        guild,
        await repoWith(row('m1')),
        REVERIFY_ROLE_ID,
        'm1',
      ),
    ).toBe(false);
    expect(roles.set).not.toHaveBeenCalled();
  });

  it('skips a member who no longer holds Reverify', async () => {
    const { guild, roles } = fakeGuild(['lounge']);

    expect(
      await moveToOnboardingIfStillUnlinked(
        guild,
        await repoWith(),
        REVERIFY_ROLE_ID,
        'm1',
      ),
    ).toBe(false);
    expect(roles.set).not.toHaveBeenCalled();
  });

  it('never moves staff', async () => {
    const { guild, roles } = fakeGuild([
      REVERIFY_ROLE_ID,
      SERVER_ROLES.moderator,
    ]);

    expect(
      await moveToOnboardingIfStillUnlinked(
        guild,
        await repoWith(),
        REVERIFY_ROLE_ID,
        'm1',
      ),
    ).toBe(false);
    expect(roles.set).not.toHaveBeenCalled();
  });
});

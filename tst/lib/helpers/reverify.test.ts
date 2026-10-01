import { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { SERVER_ROLES } from '../../../src/constants.js';
import { logModeration } from '../../../src/lib/helpers/discordLogger.js';
import {
  ReverifyCandidate,
  formatReverifyProgress,
  selectEnforceTargets,
  selectReverifyTargets,
  startRoleJob,
} from '../../../src/lib/helpers/reverify.js';
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

  it('skips members already back in Onboarding', () => {
    const members = [
      member('done', { roleIds: [REVERIFY_ROLE_ID, SERVER_ROLES.onboarding] }),
    ];
    expect(selectEnforceTargets(members, [], REVERIFY_ROLE_ID)).toEqual([]);
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
      },
    );
    await settle();

    expect(started).toBe(true);
    expect(changed).toEqual(['a', 'c']);
    const [, entry] = vi.mocked(logModeration).mock.calls[0];
    expect(entry.title).toBe('Reverify tagging finished: 2 of 3 members');
    expect(entry.description).toContain('<@b>');
  });

  it('runs one job at a time, then frees up', async () => {
    vi.mocked(logModeration).mockClear();
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    expect(startRoleJob(client, 'first', ['a'], () => blocked)).toBe(true);
    expect(startRoleJob(client, 'second', ['b'], async () => {})).toBe(false);

    release();
    await settle();
    await vi.waitFor(() =>
      expect(startRoleJob(client, 'third', [], async () => {})).toBe(true),
    );
  });
});

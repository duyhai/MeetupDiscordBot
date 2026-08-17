import { GuildMember } from 'discord.js';
import { describe, expect, it } from 'vitest';

import {
  avatarThumbUrl,
  snapshotMember,
} from '../../../src/lib/helpers/identitySnapshot.js';

function fakeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    nickname: 'Some One',
    avatar: null,
    user: {
      username: 'someone',
      globalName: 'Someone',
      avatar: 'aaa',
      bot: false,
    },
    ...overrides,
  } as unknown as GuildMember;
}

describe('snapshotMember', () => {
  it('reads every tracked field off the member', () => {
    expect(snapshotMember(fakeMember())).toEqual({
      discordUserId: 'u1',
      username: 'someone',
      globalName: 'Someone',
      nickname: 'Some One',
      userAvatarHash: 'aaa',
      memberAvatarHash: null,
    });
  });

  it('captures the per-server avatar override', () => {
    // The stealthiest impersonation vector: visible only inside this guild.
    const snap = snapshotMember(fakeMember({ avatar: 'guild-hash' }));

    expect(snap.memberAvatarHash).toBe('guild-hash');
    expect(snap.userAvatarHash).toBe('aaa');
  });
});

describe('avatarThumbUrl', () => {
  it('requests a 64px global avatar', () => {
    const url = avatarThumbUrl('u1', 'user_avatar', 'aaa', 'g1');

    expect(url).toBe('https://cdn.discordapp.com/avatars/u1/aaa.webp?size=64');
  });

  it('requests a 64px guild avatar from the guild-scoped path', () => {
    // Guild avatars live under a different CDN path; using the global path
    // returns 404 and the thumbnail silently goes missing.
    const url = avatarThumbUrl('u1', 'member_avatar', 'bbb', 'g1');

    expect(url).toBe(
      'https://cdn.discordapp.com/guilds/g1/users/u1/avatars/bbb.webp?size=64',
    );
  });
});

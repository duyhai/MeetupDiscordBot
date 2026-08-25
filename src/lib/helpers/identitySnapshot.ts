import { GuildMember } from 'discord.js';

import { IdentitySnapshot } from '../repositories/identityTypes.js';

export function snapshotMember(member: GuildMember): IdentitySnapshot {
  return {
    discordUserId: member.id,
    username: member.user.username ?? null,
    globalName: member.user.globalName ?? null,
    nickname: member.nickname ?? null,
    userAvatarHash: member.user.avatar ?? null,
    memberAvatarHash: member.avatar ?? null,
  };
}

/**
 * A 64px thumbnail URL. Discord's CDN resizes on request, which is why this
 * feature needs no image library: adding sharp (native binaries) or jimp
 * (memory-hungry) to a dyno with R14 history would cost more than it buys.
 *
 * Guild avatars live under a different path than global ones; using the
 * global path for a guild avatar 404s.
 */
export function avatarThumbUrl(
  discordUserId: string,
  field: 'user_avatar' | 'member_avatar',
  hash: string,
  guildId: string,
): string {
  if (field === 'member_avatar') {
    return `https://cdn.discordapp.com/guilds/${guildId}/users/${discordUserId}/avatars/${hash}.webp?size=64`;
  }
  return `https://cdn.discordapp.com/avatars/${discordUserId}/${hash}.webp?size=64`;
}

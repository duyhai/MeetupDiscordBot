/** Reading the whole guild's member list without the gateway. */
import { Guild, GuildMember } from 'discord.js';

export interface MemberSummary {
  id: string;
  isBot: boolean;
  roleIds: string[];
}

/**
 * Every guild member, paged over REST. Not guild.members.fetch(): that goes
 * through the gateway's request-guild-members opcode, whose budget is shared
 * with the rest of the connection -- a full-guild gateway fetch hit "Request
 * with opcode 8 was rate limited" in production (2026-10-05).
 * REST rate limits are queued by discord.js instead of thrown.
 */
export async function fetchAllMembers(guild: Guild): Promise<GuildMember[]> {
  const PAGE = 1000;
  const members: GuildMember[] = [];
  let after: string | undefined;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await guild.members.list({ limit: PAGE, after });
    members.push(...page.values());
    if (page.size < PAGE) {
      return members;
    }
    // Ids come back ascending, but take the max rather than trust the order:
    // a wrong cursor would silently skip everyone after it.
    after = [...page.keys()].reduce(function maxId(a, b) {
      return BigInt(a) > BigInt(b) ? a : b;
    });
  }
}

/**
 * The few fields a full-guild count needs, so the members themselves can be
 * dropped as soon as they are collected.
 */
export function toMemberSummary(member: GuildMember): MemberSummary {
  return {
    id: member.id,
    isBot: member.user.bot,
    roleIds: [...member.roles.cache.keys()],
  };
}

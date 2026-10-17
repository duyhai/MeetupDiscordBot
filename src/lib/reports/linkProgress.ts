import { Client } from 'discord.js';

import { GUILD_ID, SERVER_ROLES } from '../../constants.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';
import {
  fetchAllMembers,
  MemberSummary,
  toMemberSummary,
} from '../helpers/guildMembers.js';
import { MemberRecord, MemberRepository } from '../repositories/types.js';

export interface LinkProgressCounts {
  linked: number;
  unlinked: number;
  /** Always 0 now: the Reverify role was deleted on 2026-10-17. Kept so
   * link_progress_daily rows keep their shape; no page shows it. */
  reverifyTagged: number;
  onboarding: number;
}

export type LinkProgressMember = MemberSummary;

/**
 * Counts over current, non-bot guild members only: a member row for someone
 * who left the server is not progress. linked = a row with a Meetup id;
 * unlinked = not linked and not in Onboarding. A linked member who is also in
 * Onboarding is counted in both linked and onboarding; the numbers are not a
 * partition. reverifyTagged is always 0 (see LinkProgressCounts).
 */
export function countLinkProgress(
  members: LinkProgressMember[],
  rows: Pick<MemberRecord, 'discordUserId' | 'meetupId'>[],
): LinkProgressCounts {
  const linkedIds = new Set(
    rows.filter((row) => row.meetupId !== null).map((row) => row.discordUserId),
  );
  const counts: LinkProgressCounts = {
    linked: 0,
    unlinked: 0,
    reverifyTagged: 0,
    onboarding: 0,
  };
  for (const member of members) {
    if (member.isBot) {
      continue;
    }
    const inOnboarding = member.roleIds.includes(SERVER_ROLES.onboarding);
    if (linkedIds.has(member.id)) {
      counts.linked += 1;
    } else if (!inOnboarding) {
      counts.unlinked += 1;
    }
    if (inOnboarding) {
      counts.onboarding += 1;
    }
  }
  return counts;
}

/**
 * Read-only. Members are paged in full over REST (never guild.members.fetch(),
 * which uses the rate-limited gateway opcode) and then reduced to small
 * candidates, so only the candidates are kept after collection.
 */
export async function collectLinkProgress(
  client: Client,
  deps: {
    memberRepository: () => Promise<Pick<MemberRepository, 'listAll'>>;
  } = { memberRepository: ApplicationMemberRepository },
): Promise<LinkProgressCounts> {
  const guild = await client.guilds.fetch(GUILD_ID);
  const [members, rows] = await Promise.all([
    fetchAllMembers(guild).then((all) => all.map(toMemberSummary)),
    deps.memberRepository().then((repo) => repo.listAll()),
  ]);
  return countLinkProgress(members, rows);
}

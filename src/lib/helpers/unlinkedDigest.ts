import { Client } from 'discord.js';
import { Logger } from 'tslog';

import { SERVER_ROLES } from '../../constants.js';
import { ApplicationCache } from '../../util/cache.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';
import { MemberRecord } from '../repositories/types.js';
import { LogEntry, logAlert } from './discordLogger.js';

const logger = new Logger({ name: 'unlinkedDigest' });

export const DIGEST_UTC_HOUR = 17; // ≈ 9-10am Pacific
const TICK_MS = 60 * 60 * 1000; // hourly
const MAX_LISTED = 50;

export function shouldRunDigestNow(now: Date): boolean {
  return now.getUTCHours() === DIGEST_UTC_HOUR;
}

export function collectUnlinkedMemberIds(
  members: { hasOnboardingRole: boolean; id: string; isBot: boolean }[],
  rows: MemberRecord[],
): string[] {
  const linkedIds = new Set(
    rows.filter((row) => row.meetupId !== null).map((row) => row.discordUserId),
  );
  return members
    .filter(
      (member) =>
        !member.isBot && !member.hasOnboardingRole && !linkedIds.has(member.id),
    )
    .map((member) => member.id);
}

export function formatUnlinkedDigest(
  unlinkedIds: string[],
): LogEntry | undefined {
  if (unlinkedIds.length === 0) {
    return undefined;
  }
  const listed = unlinkedIds.slice(0, MAX_LISTED).map((id) => `<@${id}>`);
  const overflow = unlinkedIds.length - listed.length;
  const overflowNote = overflow > 0 ? `\n…and ${overflow} more` : '';
  return {
    title: `Unlinked member digest: ${unlinkedIds.length} verified members have no Meetup account on record`,
    description: `${listed.join(' ')}${overflowNote}`,
  };
}

export async function runDigestOnce(client: Client): Promise<void> {
  const guilds = await client.guilds.fetch();
  const guildId = guilds.first()?.id;
  if (!guildId) {
    return;
  }
  const guild = await client.guilds.fetch(guildId);
  const guildMembers = await guild.members.fetch();

  const repo = await ApplicationMemberRepository();
  const rows = await repo.listAll();

  const unlinked = collectUnlinkedMemberIds(
    guildMembers.map((member) => ({
      id: member.id,
      isBot: member.user.bot,
      hasOnboardingRole: member.roles.cache.has(SERVER_ROLES.onboarding),
    })),
    rows,
  );

  // Claim the day only after the fallible collection succeeds, so a failed
  // run leaves the claim unconsumed and a restart within the hour can retry.
  // exclusive_set guards against double-posting across dyno restarts; the
  // cache TTL (12h on Redis) is fine because the key encodes the date.
  const cache = await ApplicationCache();
  const today = new Date().toISOString().slice(0, 10);
  const claimed = await cache.exclusive_set(`unlinked-digest-${today}`, '1');
  if (!claimed) {
    return;
  }

  const entry = formatUnlinkedDigest(unlinked);
  if (entry) {
    await logAlert(client, entry);
  }
  logger.info(`Unlinked digest ran: ${unlinked.length} unlinked members`);
}

/**
 * Hourly tick that posts the digest once per day during the target UTC hour.
 * Survives Heroku's ~daily dyno cycling (a naive 24h setInterval may never
 * fire); the cache guard prevents restart double-posts within the hour.
 */
export function startUnlinkedDigestScheduler(client: Client): void {
  const tick = () => {
    if (!shouldRunDigestNow(new Date())) {
      return;
    }
    runDigestOnce(client).catch((error) =>
      logger.error(`Unlinked digest failed: ${String(error)}`),
    );
  };
  tick();
  setInterval(tick, TICK_MS);
}

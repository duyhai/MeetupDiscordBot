/**
 * The Reverify migration: getting every verified member's Meetup account
 * linked. See the "Meetup Linking Migration Plan" doc for the rollout.
 *
 * Two roles do the work:
 * - Reverify (temporary) marks who still needs to link. It changes no
 *   permissions: reminders ping it and its member count is the progress.
 *   Linking removes it.
 * - Onboarding (existing) hides channels until someone verifies. On deadline
 *   day, enforce gives it to everyone still holding Reverify.
 */
import { Client, Guild, GuildMember, Role } from 'discord.js';
import { Logger } from 'tslog';

import { SERVER_ROLES } from '../../constants.js';
import { isAdmin } from '../../util/discord.js';
import { MemberRecord } from '../repositories/types.js';
import { LogEntry, logModeration } from './discordLogger.js';

const logger = new Logger({ name: 'reverify' });

/** Found by name, so it exists only while the migration runs. */
export const REVERIFY_ROLE_NAME = 'Reverify';

export interface ReverifyCandidate {
  id: string;
  isAdmin: boolean;
  isBot: boolean;
  roleIds: string[];
}

export function toCandidate(member: GuildMember): ReverifyCandidate {
  return {
    id: member.id,
    isAdmin: isAdmin(member),
    isBot: member.user.bot,
    roleIds: [...member.roles.cache.keys()],
  };
}

/** Bots, staff, and people who never finished verifying are never touched. */
function isOutOfScope(member: ReverifyCandidate): boolean {
  return (
    member.isBot ||
    member.isAdmin ||
    member.roleIds.includes(SERVER_ROLES.moderator) ||
    member.roleIds.includes(SERVER_ROLES.organizer) ||
    member.roleIds.includes(SERVER_ROLES.onboarding)
  );
}

/**
 * Verified members with no record on file. Anyone with a record is left out:
 * a linked member is done, and a member a mod onboarded by hand (a record
 * with no Meetup ID) was vouched for.
 */
export function selectReverifyTargets(
  members: ReverifyCandidate[],
  rows: MemberRecord[],
): string[] {
  const onRecord = new Set(rows.map((row) => row.discordUserId));
  return members
    .filter((member) => !isOutOfScope(member) && !onRecord.has(member.id))
    .map((member) => member.id);
}

/**
 * Members still holding Reverify, re-checked against the same rules: a
 * linked member whose role removal failed must not lose access, and staff
 * must never be locked out even if someone tagged them by hand.
 */
export function selectEnforceTargets(
  members: ReverifyCandidate[],
  rows: MemberRecord[],
  reverifyRoleId: string,
): string[] {
  const linked = new Set(
    rows.filter((row) => row.meetupId !== null).map((row) => row.discordUserId),
  );
  return members
    .filter(
      (member) =>
        member.roleIds.includes(reverifyRoleId) &&
        !isOutOfScope(member) &&
        !linked.has(member.id),
    )
    .map((member) => member.id);
}

export function formatReverifyProgress({
  stillTagged,
  linked,
}: {
  linked: number;
  stillTagged: number;
}): LogEntry {
  return {
    title: `Reverify progress: ${stillTagged} still need to link`,
    description: `${linked} members linked to Meetup so far.`,
  };
}

export async function findReverifyRole(
  guild: Guild,
): Promise<Role | undefined> {
  const roles = await guild.roles.fetch();
  return roles.find((role) => role.name === REVERIFY_ROLE_NAME);
}

export async function ensureReverifyRole(guild: Guild): Promise<Role> {
  const existing = await findReverifyRole(guild);
  if (existing) {
    return existing;
  }
  // Mentionable so reminders can ping it; no permissions, so holding it
  // changes nothing about what a member can see.
  return guild.roles.create({
    name: REVERIFY_ROLE_NAME,
    mentionable: true,
    permissions: [],
    reason: 'Meetup linking migration',
  });
}

/**
 * Called after a successful link. Never throws: a leftover role only means
 * one extra reminder ping, while a thrown error here would fail the link.
 */
export async function removeReverifyRole(
  guild: Guild,
  userId: string,
): Promise<void> {
  try {
    const role = await findReverifyRole(guild);
    if (!role) {
      return;
    }
    const member = await guild.members.fetch(userId);
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role, 'Linked their Meetup account');
      logger.info(`Removed Reverify from ${userId}`);
    }
  } catch (error) {
    logger.warn(`Could not remove Reverify from ${userId}: ${String(error)}`);
  }
}

let runningJob: string | undefined;

/**
 * Runs a role change over many members one at a time in the background (a
 * few minutes for ~1,500 people: discord.js queues the calls under Discord's
 * rate limits), then posts the outcome to the staff moderation channel. Only
 * one job runs at a time.
 */
export function startRoleJob(
  client: Client,
  name: string,
  memberIds: string[],
  change: (memberId: string) => Promise<void>,
): boolean {
  if (runningJob) {
    return false;
  }
  runningJob = name;
  (async () => {
    let done = 0;
    const failed: string[] = [];
    for (const memberId of memberIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await change(memberId);
        done += 1;
      } catch (error) {
        failed.push(memberId);
        logger.warn(`${name} failed for ${memberId}: ${String(error)}`);
      }
    }
    await logModeration(client, {
      title: `${name} finished: ${done} of ${memberIds.length} members`,
      description: failed.length
        ? `Failed for ${failed.length}: ${failed
            .slice(0, 30)
            .map((id) => `<@${id}>`)
            .join(' ')}${failed.length > 30 ? ' …' : ''}`
        : 'No failures.',
    });
  })()
    .catch((error) => logger.error(`${name} crashed: ${String(error)}`))
    .finally(() => {
      runningJob = undefined;
    });
  return true;
}

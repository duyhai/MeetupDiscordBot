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
import { MemberRecord, MemberRepository } from '../repositories/types.js';
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

/**
 * Every guild member, paged over REST. Not guild.members.fetch(): that goes
 * through the gateway's request-guild-members opcode, whose budget is shared
 * with the rest of the connection -- a preview run followed by confirm:true
 * hit "Request with opcode 8 was rate limited" in production (2026-10-05).
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

export function toCandidate(member: GuildMember): ReverifyCandidate {
  return {
    id: member.id,
    isAdmin: isAdmin(member),
    isBot: member.user.bot,
    roleIds: [...member.roles.cache.keys()],
  };
}

function isStaffOrBot(member: ReverifyCandidate): boolean {
  return (
    member.isBot ||
    member.isAdmin ||
    member.roleIds.includes(SERVER_ROLES.moderator) ||
    member.roleIds.includes(SERVER_ROLES.organizer)
  );
}

/** Bots, staff, and people who never finished verifying are never tagged. */
function isOutOfScope(member: ReverifyCandidate): boolean {
  return (
    isStaffOrBot(member) || member.roleIds.includes(SERVER_ROLES.onboarding)
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
 * must never be locked out even if someone tagged them by hand. Members
 * already in Onboarding are included so they lose the tag too.
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
        !isStaffOrBot(member) &&
        !linked.has(member.id),
    )
    .map((member) => member.id);
}

/**
 * The jobs take minutes, and people link while they run. So each member is
 * re-checked against fresh data right before their roles change; a member
 * who no longer qualifies is skipped (returns false).
 */
async function fetchFresh(guild: Guild, repo: MemberRepository, id: string) {
  const [member, record] = await Promise.all([
    guild.members.fetch({ user: id, force: true }),
    repo.findByDiscordId(id),
  ]);
  return { member, candidate: toCandidate(member), record };
}

export async function tagIfStillUnlinked(
  guild: Guild,
  repo: MemberRepository,
  reverifyRole: Role,
  memberId: string,
): Promise<boolean> {
  const { member, candidate, record } = await fetchFresh(guild, repo, memberId);
  if (
    record ||
    isOutOfScope(candidate) ||
    candidate.roleIds.includes(reverifyRole.id)
  ) {
    return false;
  }
  await member.roles.add(
    reverifyRole,
    'Meetup linking migration: no Meetup link on record',
  );
  return true;
}

export async function moveToOnboardingIfStillUnlinked(
  guild: Guild,
  repo: MemberRepository,
  reverifyRoleId: string,
  memberId: string,
): Promise<boolean> {
  const { member, candidate, record } = await fetchFresh(guild, repo, memberId);
  if (
    record?.meetupId ||
    isStaffOrBot(candidate) ||
    !candidate.roleIds.includes(reverifyRoleId)
  ) {
    return false;
  }
  // One call swaps Reverify for Onboarding, so a failure can't leave a
  // member holding both (or neither).
  const roles = new Set(candidate.roleIds);
  roles.delete(reverifyRoleId);
  roles.delete(guild.id); // @everyone
  roles.add(SERVER_ROLES.onboarding);
  await member.roles.set(
    [...roles],
    'Meetup linking deadline passed without a link',
  );
  return true;
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
 * one job runs at a time. `change` returns false when it skipped a member.
 */
export function startRoleJob(
  client: Client,
  name: string,
  memberIds: string[],
  change: (memberId: string) => Promise<boolean>,
): boolean {
  if (runningJob) {
    return false;
  }
  runningJob = name;
  (async () => {
    let done = 0;
    let skipped = 0;
    const failed: string[] = [];
    for (const memberId of memberIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        if (await change(memberId)) {
          done += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        failed.push(memberId);
        logger.warn(`${name} failed for ${memberId}: ${String(error)}`);
      }
    }
    const skippedNote = skipped
      ? `Skipped ${skipped} who linked or changed since the job started.\n`
      : '';
    await logModeration(client, {
      title: `${name} finished: ${done} of ${memberIds.length} members`,
      description:
        skippedNote +
        (failed.length
          ? `Failed for ${failed.length}: ${failed
              .slice(0, 30)
              .map((id) => `<@${id}>`)
              .join(' ')}${failed.length > 30 ? ' …' : ''}`
          : 'No failures.'),
    });
  })()
    .catch((error) => logger.error(`${name} crashed: ${String(error)}`))
    .finally(() => {
      runningJob = undefined;
    });
  return true;
}

import { Guild, CommandInteraction, User, ButtonInteraction } from 'discord.js';
import { Logger } from 'tslog';
import {
  RewardRoleLevels,
  RewardRoles,
  REWARD_ROLES,
  ServerRoles,
  SERVER_ROLES,
} from '../../constants.js';
import { ApplicationCache } from '../../util/cache.js';
import { describeInteraction, isAdmin, linkStr } from '../../util/discord.js';
import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { MemberGender } from '../client/meetup/types.js';
import { logAlert } from './discordLogger.js';
import { updateBaselineSilently } from './identityMonitor.js';
import {
  releaseIdentityWriteSuppression,
  suppressIdentityWrites,
} from './identitySuppression.js';
import { recordManualOnboard, recordMeetupLink } from './memberLink.js';

/**
 * A Meetup account that is not in the group. The alert naming the person is
 * posted where this is thrown, so discordCommandWrapper must skip its generic
 * failure alert rather than report the same event twice.
 */
export class NonMemberError extends Error {
  readonly alertHandled = true;
}

const strings = {
  welcomeMsg: (user: User) =>
    `
Welcome ${user.toString()}. \
Please go to <id:browse> in the left menu to join different discussion channels. \
Have fun exploring the server!
`,
  replyToModerator:
    'User is onboarded! Please make sure you checked their intro, Meetup profile and name (FirstName + LastName/Initial)',
  invisibleCharacter: ' ',
};

const logger = new Logger({ name: 'onboardUserHelper' });

export async function addServerRole(
  guild: Guild,
  userId: string,
  role: ServerRoles,
) {
  const user = await guild.members.fetch(userId);
  const serverRole = await guild.roles.fetch(SERVER_ROLES[role]);
  await user.roles.add(serverRole);
}

export async function removeServerRole(
  guild: Guild,
  userId: string,
  role: ServerRoles,
) {
  const user = await guild.members.fetch(userId);
  const serverRole = await guild.roles.fetch(SERVER_ROLES[role]);
  await user.roles.remove(serverRole);
}

/**
 * Brings a member's reward roles in line with the levels they earned, using at
 * most one request.
 *
 * The previous shape of this -- remove all six levels of a category, then add
 * back the earned one -- cost 12 DELETEs plus up to 2 PUTs on every
 * verification, even for a member whose badges had not changed. discord.js
 * sends one REST call per role and they share a rate-limit bucket, so they
 * queue serially: measured at 9s of a ~11s verification in production on
 * 2026-08-16. Diffing first means an unchanged member costs nothing and a
 * changed one costs a single PATCH.
 *
 * Only the categories present in `targets` are rewritten. Everything else the
 * member holds -- organizer, moderator, the retired Discord-linked badge --
 * is carried through untouched.
 *
 * A level of `undefined` means "earned nothing here" and strips the category.
 * That case is load-bearing: it comes from `levels.find(...)` returning
 * undefined, and the old code path fetched roles by id without guarding it,
 * which resolved to EVERY role in the guild and produced
 * DiscordAPIError[50013] Missing Permissions.
 */
export async function syncRewardRoles(
  guild: Guild,
  userId: string,
  targets: Partial<Record<RewardRoles, RewardRoleLevels | undefined>>,
) {
  const member = await guild.members.fetch(userId);

  const categories = Object.keys(targets) as RewardRoles[];
  // Every id we are responsible for, across the requested categories only.
  const managed = new Set(
    categories.flatMap((category) => Object.values(REWARD_ROLES[category])),
  );
  const earned = categories
    .map((category) => {
      const level = targets[category];
      return level === undefined ? undefined : REWARD_ROLES[category][level];
    })
    .filter((id): id is string => Boolean(id));

  const current = [...member.roles.cache.keys()];
  const desired = new Set([
    ...current.filter((id) => !managed.has(id)),
    ...earned,
  ]);

  const unchanged =
    desired.size === current.length && current.every((id) => desired.has(id));
  if (unchanged) {
    logger.info(`Reward roles already correct for ${userId}; no change`);
    return;
  }

  // Logged on both sides of the call: the old remove-then-add path emitted
  // nothing once it succeeded, which is why its cost stayed invisible in
  // production until someone timed the gap between surrounding log lines.
  logger.info(`Updating reward roles for ${userId}`);
  await member.roles.set([...desired]);
  logger.info(`Reward roles updated for ${userId}`);
}

export async function onboardUserCommon(
  interaction: CommandInteraction | ButtonInteraction,
  userId: string,
  gender: MemberGender,
  nickname?: string,
) {
  const { guild, client } = interaction;
  const user = await client.users.fetch(userId);
  const fullUsername = user.tag;

  logger.info(`User ${fullUsername} is getting onboarded`);

  const guildMember = await guild.members.fetch(userId);
  if (!isAdmin(guildMember)) {
    let targetNickName = nickname || guildMember.nickname;
    if (!targetNickName) {
      const { username } = user;
      // Ugly hack because of this:
      // https://github.com/discord/discord-api-docs/issues/667
      targetNickName = Array.from(username).join(strings.invisibleCharacter);
    }
    // Suppress BEFORE the write, not after: Discord dispatches
    // GUILD_MEMBER_UPDATE concurrently with setNickname's HTTP response, so
    // the gateway handler can be diffing this member while we are still
    // waiting here. Without the flag already set, the bot's own rename gets
    // recorded as a suspicious change and lands in the organizers' digest.
    suppressIdentityWrites(guildMember.id);
    try {
      await guildMember.setNickname(targetNickName);
      logger.info(
        `Explicitly set ${fullUsername}'s nickname to ${targetNickName}`,
      );
      // The bot just wrote this nickname. Advance the baseline so its own
      // write is not reported as a suspicious name change in the daily digest.
      // A failure here is deliberately swallowed: this is a background
      // monitoring write, and onboarding (role assignment below) must complete
      // even if the identity repository is down. Losing one baseline update is
      // survivable -- the daily sweep re-derives it -- but aborting onboarding
      // mid-flow is not.
      try {
        await updateBaselineSilently(guildMember);
      } catch (error: unknown) {
        logger.error(
          `Failed to update identity baseline for ${fullUsername}: ${String(error)}`,
        );
      }
    } finally {
      // Lifts a few seconds from now, not instantly: the event this write
      // triggered may still be in flight. `finally` so a failed setNickname
      // cannot leave the member suppressed for the full hard TTL.
      releaseIdentityWriteSuppression(guildMember.id);
    }
  }

  switch (gender) {
    case 'MALE': {
      await addServerRole(guild, user.id, 'gents_lounge');
      logger.info(`User ${fullUsername} added to GentsLounge`);
      break;
    }
    case 'FEMALE': {
      await addServerRole(guild, user.id, 'ladies_lounge');
      logger.info(`User ${fullUsername} added to LadiesLounge`);
      break;
    }
    default:
      break;
  }
  await removeServerRole(guild, user.id, 'onboarding');
  logger.info(`User ${fullUsername} onboarded!`);
}

/*
 * Function to onboard a target user
 */
export async function onboardUser(
  interaction: CommandInteraction,
  userId: string,
  gender: MemberGender,
) {
  const { client } = interaction;
  const user = await client.users.fetch(userId);

  await onboardUserCommon(interaction, userId, gender);
  await recordManualOnboard(interaction, userId);
  await interaction.followUp({
    content: strings.replyToModerator,
    ephemeral: true,
  });
  await interaction.followUp({
    content: strings.welcomeMsg(user),
  });
}

/*
 * Function to onboard self
 */
export async function selfOnboardUser(
  meetupClient: GqlMeetupClient,
  interaction: CommandInteraction | ButtonInteraction,
): Promise<{ meetupMemberUrl: string; meetupName: string }> {
  const { user: discordUser } = interaction;

  const userInfo = await meetupClient.getUserInfo();
  const membershipInfo = await meetupClient.getUserMembershipInfo();

  const isMeetupGroupMember = membershipInfo.groupByUrlname.isMember;

  if (!isMeetupGroupMember) {
    const cache = await ApplicationCache();
    await cache.remove(`${interaction.user.id}-meetup-tokens`);

    logger.warn(
      `Non-member user failed to onboard: ${interaction.user.username}.
            Membership info: ${JSON.stringify(membershipInfo)}`,
    );

    // These are real people who wanted in and bounced off, so the alert
    // carries enough to reach them: the Meetup account they authorized with
    // is theirs even though they never joined the group.
    const { id: meetupId, name: meetupName, memberUrl } = userInfo.self;
    const profile = memberUrl
      ? linkStr(meetupName, memberUrl)
      : `${meetupName} (no profile url)`;

    await logAlert(interaction.client, {
      title: 'Non-member tried to verify',
      description: `${discordUser.toString()} (${
        discordUser.username
      }) authorized Meetup as ${profile} but is not in the group.`,
      fields: [
        { inline: true, name: 'Meetup ID', value: meetupId },
        {
          inline: true,
          name: 'Attempt',
          value: describeInteraction(interaction),
        },
      ],
    });

    throw new NonMemberError(
      `You're not a member on Meetup. Please join the group and try onboarding again`,
    );
  }

  const { name } = userInfo.self;
  const cleanedName = name
    .split(' ')
    .filter(Boolean)
    .map((namePart, index) => {
      const formattedPart =
        namePart.charAt(0).toUpperCase() + namePart.slice(1).toLowerCase();

      if (index === 0) {
        return formattedPart;
      }
      return `${formattedPart.at(0)}.`;
    })
    .join(' ');

  logger.info(
    `Updating ${discordUser.username}'s display name to ${cleanedName} (Meetup name: ${name}).`,
  );
  await recordMeetupLink(
    interaction,
    {
      meetupId: userInfo.self.id,
      meetupName: userInfo.self.name,
      meetupMemberUrl: userInfo.self.memberUrl,
    },
    'self_onboard',
  );
  await onboardUserCommon(
    interaction,
    discordUser.id,
    userInfo.self.gender,
    cleanedName,
  );
  return { meetupName: name, meetupMemberUrl: userInfo.self.memberUrl };
}

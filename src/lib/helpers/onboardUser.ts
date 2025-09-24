import { Guild, CommandInteraction, User, ButtonInteraction } from 'discord.js';
import { Logger } from 'tslog';
import {
  RewardRoleLevels,
  RewardRoles,
  REWARD_ROLES,
  ServerRoles,
  SERVER_ROLES,
} from '../../constants';
import { isAdmin } from '../../util/discord';
import { GqlMeetupClient } from '../client/meetup/gqlClient';
import { MemberGender } from '../client/meetup/types';

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
  role: ServerRoles
) {
  const user = await guild.members.fetch(userId);
  const serverRole = await guild.roles.fetch(SERVER_ROLES[role]);
  await user.roles.add(serverRole);
}

export async function addRewardRole(
  guild: Guild,
  userId: string,
  role: RewardRoles,
  level: RewardRoleLevels
) {
  const user = await guild.members.fetch(userId);
  const rewardRole = await guild.roles.fetch(REWARD_ROLES[role][level]);
  await user.roles.add(rewardRole);
}

export async function removeServerRole(
  guild: Guild,
  userId: string,
  role: ServerRoles
) {
  const user = await guild.members.fetch(userId);
  const serverRole = await guild.roles.fetch(SERVER_ROLES[role]);
  await user.roles.remove(serverRole);
}

export async function removeRewardRole(
  guild: Guild,
  userId: string,
  role: RewardRoles,
  levels: RewardRoleLevels[] = [1, 5, 20, 50, 100, 500]
) {
  const user = await guild.members.fetch(userId);
  await Promise.all(
    levels.map(async (lvl) => {
      const rewardRole = await guild.roles.fetch(REWARD_ROLES[role][lvl]);
      await user.roles.remove(rewardRole);
    })
  );
}

async function onboardUserCommon(
  interaction: CommandInteraction | ButtonInteraction,
  userId: string,
  gender: MemberGender,
  nickname?: string
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
    await guildMember.setNickname(targetNickName);
    logger.info(
      `Explicitly set ${fullUsername}'s nickname to ${targetNickName}`
    );
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
  gender: MemberGender
) {
  const { client } = interaction;
  const user = await client.users.fetch(userId);

  await onboardUserCommon(interaction, userId, gender);
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
  interaction: CommandInteraction | ButtonInteraction
) {
  const { user: discordUser } = interaction;

  const userInfo = await meetupClient.getUserInfo();
  const membershipInfo = await meetupClient.getUserMembershipInfo();

  const isMeetupGroupMember = membershipInfo.groupByUrlname.isMember;

  if (!isMeetupGroupMember) {
    logger.warn(
      `Non-member user failed to onboard: ${interaction.user.username}. 
            Membership info: ${JSON.stringify(membershipInfo)}`
    );
    throw new Error(
      `You're not a member on Meetup. Please join the group and try onboarding again`
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
    `Updating ${discordUser.username}'s display name to ${cleanedName} (Meetup name: ${name}).`
  );
  await onboardUserCommon(
    interaction,
    discordUser.id,
    userInfo.self.gender,
    cleanedName
  );
  await interaction.followUp({
    content: strings.welcomeMsg(discordUser),
    ephemeral: true,
  });
}

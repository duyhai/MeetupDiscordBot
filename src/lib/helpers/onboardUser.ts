import { Guild, GuildBasedChannel, CommandInteraction, User } from 'discord.js';
import { Logger } from 'tslog';
import {
  DISCUSSION_JOIN_CHANNEL_ID,
  INTEREST_JOIN_CHANNEL_ID,
  Roles,
  SERVER_ROLES,
} from '../../constants';
import { isAdmin } from '../../util/discord';

const strings = {
  welcomeMsg: (
    user: User,
    discussionJoinChannel: GuildBasedChannel,
    interestJoinChannel: GuildBasedChannel
  ) =>
    `
Welcome ${user.toString()}. Check out some of our interest channels! ${discussionJoinChannel.toString()} ${interestJoinChannel.toString()} \
Please make sure to turn off notifications for all messages and to mute channels you're not interested in if you're getting overwhelmed :) 
Have fun exploring the server!
`,
  replyToModerator:
    'User is onboarded! Please make sure you checked their intro, Meetup profile and name (FirstName + LastName/Initial)',
  invisibleCharacter: ' ',
};

const logger = new Logger({ name: 'onboardUserHelper' });

async function addRole(guild: Guild, userId: string, role: Roles) {
  const user = await guild.members.fetch(userId);
  const ladiesRole = await guild.roles.fetch(SERVER_ROLES[role]);
  await user.roles.add(ladiesRole);
}

async function removeRole(guild: Guild, userId: string, role: Roles) {
  const user = await guild.members.fetch(userId);
  const onboardingRole = await guild.roles.fetch(SERVER_ROLES[role]);
  await user.roles.remove(onboardingRole);
}

async function onboardUserCommon(
  interaction: CommandInteraction,
  userId: string,
  isFemale: boolean,
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

  if (isFemale) {
    await addRole(guild, user.id, 'ladies_lounge');
    logger.info(`User ${fullUsername} added to LadiesLounge`);
  }
  await removeRole(guild, user.id, 'onboarding');
  logger.info(`User ${fullUsername} onboarded!`);
}

/*
 * Function to onboard a target user
 */
export async function onboardUser(
  interaction: CommandInteraction,
  userId: string,
  isFemale: boolean
) {
  const { guild, client } = interaction;
  const user = await client.users.fetch(userId);

  const discussionJoinChannel = await guild.channels.fetch(
    DISCUSSION_JOIN_CHANNEL_ID
  );
  const interestJoinChannel = await guild.channels.fetch(
    INTEREST_JOIN_CHANNEL_ID
  );
  await onboardUserCommon(interaction, userId, isFemale);
  await interaction.editReply({
    content: strings.replyToModerator,
  });
  await interaction.followUp({
    content: strings.welcomeMsg(
      user,
      discussionJoinChannel,
      interestJoinChannel
    ),
  });
}

/*
 * Function to onboard self
 */
export async function selfOnboardUser(
  interaction: CommandInteraction,
  nickname: string,
  isFemale: boolean
) {
  const { guild, user } = interaction;
  const discussionJoinChannel = await guild.channels.fetch(
    DISCUSSION_JOIN_CHANNEL_ID
  );
  const interestJoinChannel = await guild.channels.fetch(
    INTEREST_JOIN_CHANNEL_ID
  );
  await onboardUserCommon(interaction, user.id, isFemale, nickname);
  await interaction.editReply({
    content: strings.welcomeMsg(
      user,
      discussionJoinChannel,
      interestJoinChannel
    ),
  });
}

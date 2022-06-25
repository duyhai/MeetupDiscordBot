import {
  Guild,
  GuildBasedChannel,
  BaseCommandInteraction,
  User,
  AnyChannel,
} from 'discord.js';
import { Logger } from 'tslog';
import {
  DISCUSSION_JOIN_CHANNEL_ID,
  INTEREST_JOIN_CHANNEL_ID,
  LADIES_LOUNGE_ROLE_ID,
  ONBOARDING_ROLE_ID,
} from '../../constants';

const strings = {
  welcomeMsg: (
    user: User,
    discussionJoinChannel: GuildBasedChannel,
    interestJoinChannel: GuildBasedChannel
  ) =>
    `
Welcome ${user.toString()}. Check out some of our interest channels! ${discussionJoinChannel.toString()} ${interestJoinChannel.toString()} \
Please make sure to turn off notifications for all messages and to mute channels you're not interested in if you're getting overwhelmed :)\ 
Have fun exploring the server!
`,
  replyToModerator:
    'User is onboarded! Please make sure you checked their intro, Meetup profile and name (FirstName + LastName/Initial)',
  replyAddedToChannel: (channel: AnyChannel) =>
    `You have been added to ${channel.toString()}. Have fun!`,
  invisibleCharacter: ' ',
};

const logger = new Logger({ name: 'onboardUser' });

async function addToLadiesLounge(guild: Guild, userId: string) {
  const user = await guild.members.fetch(userId);
  const ladiesRole = await guild.roles.fetch(LADIES_LOUNGE_ROLE_ID);
  await user.roles.add(ladiesRole);
}

async function removeFromOnboarding(guild: Guild, userId: string) {
  const user = await guild.members.fetch(userId);
  const onboardingRole = await guild.roles.fetch(ONBOARDING_ROLE_ID);
  await user.roles.remove(onboardingRole);
}

export async function onboardUser(
  interaction: BaseCommandInteraction,
  userId: string,
  isFemale: boolean
) {
  await interaction.deferReply();
  const { guild, client } = interaction;
  const user = await client.users.fetch(userId);
  const fullUsername = user.tag;

  logger.info(`User ${fullUsername} is getting onboarded`);
  const discussionJoinChannel = await guild.channels.fetch(
    DISCUSSION_JOIN_CHANNEL_ID
  );
  const interestJoinChannel = await guild.channels.fetch(
    INTEREST_JOIN_CHANNEL_ID
  );

  const guildMember = await guild.members.fetch(userId);
  if (!guildMember.nickname) {
    const { username } = user;
    // Ugly hack because of this:
    // https://github.com/discord/discord-api-docs/issues/667
    const paddedUsername = Array.from(username).join(
      strings.invisibleCharacter
    );
    await guildMember.setNickname(paddedUsername);
    logger.info(
      `Explicitly set ${fullUsername}'s nickname to ${paddedUsername}`
    );
  }

  if (isFemale) {
    await addToLadiesLounge(guild, user.id);
    logger.info(`User ${fullUsername} added to LadiesLounge`);
  }
  await removeFromOnboarding(guild, user.id);
  logger.info(`User ${fullUsername} onboarded!`);

  await interaction.editReply({
    content: strings.welcomeMsg(
      user,
      discussionJoinChannel,
      interestJoinChannel
    ),
  });
  await interaction.followUp({
    ephemeral: true,
    content: strings.replyToModerator,
  });
}

export async function addToChannel(
  interaction: BaseCommandInteraction,
  channelId: string
) {
  await interaction.deferReply({
    ephemeral: true,
  });
  const { user, guild } = interaction;
  logger.info(
    `User ${user.username} is being added to channel with ID: ${channelId}`
  );

  const channel = await guild.channels.fetch(channelId);

  await channel.permissionOverwrites.create(user.id, {
    VIEW_CHANNEL: true,
  });

  logger.info(`User ${user.username} is added to ${channel.name}`);
  await interaction.editReply({
    content: strings.replyAddedToChannel(channel),
  });
}

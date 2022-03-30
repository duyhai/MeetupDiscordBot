import {
  Guild,
  GuildBasedChannel,
  BaseCommandInteraction,
  User,
} from 'discord.js';
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
    `Welcome ${user.toString()}. Have fun exploring the server! \
    Check out some of our interest channels! ${discussionJoinChannel.toString()} ${interestJoinChannel.toString()}`,
  replyToModerator:
    'User is onboarded! Please make sure you checked their intro, Meetup profile and name (FirstName + LastName/Initial)',
};

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
  const discussionJoinChannel = await guild.channels.fetch(
    DISCUSSION_JOIN_CHANNEL_ID
  );
  const interestJoinChannel = await guild.channels.fetch(
    INTEREST_JOIN_CHANNEL_ID
  );

  if (isFemale) {
    await addToLadiesLounge(guild, user.id);
  }
  await removeFromOnboarding(guild, user.id);

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

import {
  Channel,
  CommandInteraction,
  NonThreadGuildBasedChannel,
} from 'discord.js';
import { Logger } from 'tslog';

const logger = new Logger({ name: 'channelHelper' });

const strings = {
  replyAddedToChannel: (channel: Channel) =>
    `You have been added to ${channel.toString()}. Have fun!`,
};

export async function addToChannel(
  interaction: CommandInteraction,
  channelId: string
) {
  const { user, guild } = interaction;
  logger.info(
    `User ${user.username} is being added to channel with ID: ${channelId}`
  );

  const channel = (await guild.channels.fetch(
    channelId
  )) as NonThreadGuildBasedChannel;

  await channel.permissionOverwrites.create(user.id, {
    ViewChannel: true,
  });

  logger.info(`User ${user.username} is added to ${channel.name}`);
  await interaction.followUp({
    content: strings.replyAddedToChannel(channel),
    ephemeral: true,
  });
}

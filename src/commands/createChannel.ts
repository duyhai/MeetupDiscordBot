import {
  BaseCommandInteraction, Channel, Client, CommandInteraction,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';

@Discord()
export class CreateChannel {
  @Slash('createchannel')
  async createchannel(
  @SlashOption('channel_name', { description: 'Name of the new channel.' })
    channelName: string,
    @SlashOption('channel_emoji', { description: 'Emoji for the channel.' })
    channelEmoji: string,
    @SlashOption('join_channel', { description: 'Category of the channel.' })
    joinChannel: Channel,

    interaction: CommandInteraction,
  ) {
    // const category = await client.channels.fetch(categoryID).catch()
    // as unknown as CategoryChannel;

    // if (category === undefined || category.type !== 'GUILD_CATEGORY') {
    //   await interaction.followUp({
    //     ephemeral: true,
    //     content: 'Error: category was not found!',
    //   });
    //   return;
    // }

    // const name = emoji + channelName;
    // if (interaction.guild.channels.cache.find(
    //   (c) => c.name.toLowerCase() === name,
    // ) !== undefined) {
    //   await interaction.followUp({
    //     ephemeral: true,
    //     content: 'Error: channel with this name already exists!',
    //   });
    //   return;
    // }

    // // TODO: check if second option is really just an emoji

    // const channel = await interaction.guild.channels.create(name, {
    //   type: 'GUILD_TEXT',
    // });
    // await channel.setParent(category);

    // const role = await interaction.guild.roles.create({
    //   name: channelName,
    // });
    // const zapierBot = await interaction.guild.members.fetch(zapierBotID);
    // await channel.permissionOverwrites.create(
    //   interaction.guild.roles.everyone, // sometimes it returns undefined for no reason
    //   { VIEW_CHANNEL: false },
    // );
    // await channel.permissionOverwrites.create(zapierBot, { VIEW_CHANNEL: true });
    // await channel.permissionOverwrites.create(role, { VIEW_CHANNEL: true });

    // const botCommandsChannel = interaction.guild.channels.cache
    //   .get(botCommandsChannelID) as TextChannel;
    // await botCommandsChannel.send(`z/channel ${joinChannelID}`);
    // await botCommandsChannel.send(`z/message ${messageID}`);
    // await botCommandsChannel.send(`z/add ${emoji} ${channelName}`);

    // await interaction.followUp({
    //   ephemeral: true,
    //   content: 'Channel is done!',
    // });
  }
}

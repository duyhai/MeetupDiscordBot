import {
  BaseCommandInteraction, Channel, Client, CommandInteraction, TextChannel,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';

// Create and setup channels
// - Decide on an emoji for the channel
// - Create channel under discussions and categories and make it private. Make sure to include the emoji in the name.
// - Create corresponding role and clear permissions
// - Add Bot and freshly created role to channel
// - Edit the role assignment message in join-discussion-channels // TODO
// - Set up the Zira bot to assign role when reacting to role assignment message:
//   - Go to 🤖bot-commands
//   - Get the join-discussion-channels id with the copy link option. In the case of Discussions category the link is https://discord.com/channels/912461362289061939/935080178181373992, so the id is 935080178181373992
//   - Message z/channel <id here>
//   - Get the role assignment message id similarly as above for the channel. Link should look like this: https://discord.com/channels/912461362289061939/935080178181373992/935080771536953394
//   - Message z/message <id here>
//   - Message z/add <emoji here> <role name>
// - You're done!

const zapierBotID = '368105370532577280';
const botCommandsChannelID = '915035889174990899';
const joinChannelID = '935080178181373992';
const messageID = '935080771536953394';

const strings = {
  duplicateChannel: 'Channel with same name and emoji already exists!',
};

@Discord()
export class CreateChannel {
  @Slash('createchannel')
  async createchannel(
  @SlashOption('channel_name', { description: 'Name of the new channel.' })
    channelName: string,
    @SlashOption('channel_emoji', { description: 'Emoji for the channel.' })
    channelEmoji: string,
    @SlashOption('join_channel', { description: 'Category of the channel.' })
    joinChannel: TextChannel,

    interaction: CommandInteraction,
  ) {
    const fullChannelName = channelEmoji + channelName;

    if (interaction.guild.channels.cache.find(
      (channel) => channel.name === fullChannelName,
    ) != null) {
      await interaction.reply(
        {
          content: strings.duplicateChannel,
        },
      );
    }

    // // TODO: check if second option is really just an emoji

    const channelRole = await interaction.guild.roles.create({
      name: channelName,
    }).then((role) => role.setPermissions(0n)); // Clear permissions

    await interaction.guild.channels.create(fullChannelName, {
      type: 'GUILD_TEXT',
      parent: joinChannel.parent,
      permissionOverwrites: [
        {
          id: interaction.guildId,
          deny: ['VIEW_CHANNEL'],
        },
        {
          id: channelRole.id,
          allow: ['VIEW_CHANNEL'],
        },
        {
          id: zapierBotID,
          allow: ['VIEW_CHANNEL'],
        },
      ],
    });

    const botCommandsChannel = interaction.guild.channels.cache
      .get(botCommandsChannelID) as TextChannel;
    await botCommandsChannel.send(`z/channel ${joinChannelID}`);
    await botCommandsChannel.send(`z/message ${messageID}`);
    await botCommandsChannel.send(`z/add ${channelEmoji} ${channelName}`);

    await interaction.followUp({
      ephemeral: true,
      content: 'Channel is done!',
    });
  }
}

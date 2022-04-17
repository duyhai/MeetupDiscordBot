import { CommandInteraction, TextChannel } from 'discord.js';
import { Discord, Permission, Slash, SlashChoice, SlashOption } from 'discordx';
import {
  BOTS_ROLE_ID,
  BOT_COMMANDS_CHANNEL_ID,
  commandNames,
  DISCUSSION_JOIN_CHANNEL_ID,
  DISCUSSION_JOIN_MESSAGE_ID,
  INTEREST_JOIN_CHANNEL_ID,
  INTEREST_JOIN_MESSAGE_ID,
  MODERATOR_ROLE_ID,
} from '../constants';
import { capitalize } from '../util/strings';

// Create and setup channels
// - Decide on an emoji for the channel
// - Create channel under discussions and categories and make it private.
//        Make sure to include the emoji in the name.
// - Create corresponding role and clear permissions
// - Add Bot and freshly created role to channel
// - Edit the role assignment message in join-discussion-channels       // TODO
// - Set up the Zira bot to assign role when reacting to role assignment message:
//   - Go to 🤖bot-commands
//   - Get the join-discussion-channels id with the copy link option. In the case of Discussions category the link is https://discord.com/channels/912461362289061939/935080178181373992, so the id is 935080178181373992
//   - Message z/channel <id here>
//   - Get the role assignment message id similarly as above for the channel. Link should look like this: https://discord.com/channels/912461362289061939/935080178181373992/935080771536953394
//   - Message z/message <id here>
//   - Message z/add <emoji here> <role name>
// - You're done!

const strings = {
  duplicateChannel: 'Channel with same name and emoji already exists!',
  options: {
    channelName: {
      name: 'channel_name',
      description: 'Name of the new channel.',
    },
    channelEmoji: {
      name: 'channel_emoji',
      description: 'Emoji for the channel.',
    },
    joinChannel: {
      name: 'channel_category',
      description: 'Category of the channel.',
    },
  },
  choices: {
    channelCategory: {
      discussion: {
        name: 'Discussion',
        value: 'discussion',
        channelId: DISCUSSION_JOIN_CHANNEL_ID,
        messageId: DISCUSSION_JOIN_MESSAGE_ID,
      },
      interest: {
        name: 'Interest',
        value: 'interest',
        channelId: INTEREST_JOIN_CHANNEL_ID,
        messageId: INTEREST_JOIN_MESSAGE_ID,
      },
    },
  },
};

@Discord()
export class CreateChannel {
  @Permission(false)
  @Permission({ id: MODERATOR_ROLE_ID, type: 'ROLE', permission: true })
  @Slash(commandNames.channel.create)
  async createchannel(
    @SlashOption(strings.options.channelName.name, {
      description: strings.options.channelName.description,
    })
    channelName: string,

    @SlashOption(strings.options.channelEmoji.name, {
      description: strings.options.channelEmoji.description,
    })
    channelEmoji: string,

    @SlashChoice(
      strings.choices.channelCategory.discussion.name,
      strings.choices.channelCategory.discussion.value
    )
    @SlashChoice(
      strings.choices.channelCategory.interest.name,
      strings.choices.channelCategory.interest.value
    )
    @SlashOption(strings.options.joinChannel.name, {
      description: strings.options.joinChannel.description,
    })
    channelCategory: string,

    interaction: CommandInteraction
  ) {
    const fullChannelName = channelEmoji + channelName;

    if (
      interaction.guild.channels.cache.find(
        (channel) => channel.name === fullChannelName
      ) != null
    ) {
      await interaction.reply({
        ephemeral: true,
        content: strings.duplicateChannel,
      });
      return;
    }

    // // TODO: check if second option is really just an emoji

    const channelRole = await interaction.guild.roles
      .create({
        name: capitalize(channelName),
      })
      .then((role) => role.setPermissions(0n)); // Clear permissions

    const channelInformation =
      strings.choices.channelCategory[
        channelCategory as keyof typeof strings.choices.channelCategory
      ];

    const joinChannel = await interaction.guild.channels.fetch(
      channelInformation.channelId
    );
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
          id: BOTS_ROLE_ID,
          allow: ['VIEW_CHANNEL'],
        },
      ],
    });

    const botCommandsChannel = interaction.guild.channels.cache.get(
      BOT_COMMANDS_CHANNEL_ID
    ) as TextChannel;
    // TODO: Create Zira message so that this message modification can be a Zira command too
    await botCommandsChannel.send(
      `Please copy paste these commands one by one, then add the channel to the join channel message`
    );
    await botCommandsChannel.send(`z/channel ${channelInformation.channelId}`);
    await botCommandsChannel.send(`z/message ${channelInformation.messageId}`);
    await botCommandsChannel.send(`z/add ${channelEmoji} ${channelName}`);

    await interaction.reply({
      ephemeral: true,
      content: 'Channel is done!',
    });
  }
}

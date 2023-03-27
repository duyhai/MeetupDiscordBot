import {
  ApplicationCommandOptionType,
  ChannelType,
  CommandInteraction,
  PermissionsBitField,
  TextChannel,
} from 'discord.js';
import { Discord, Slash, SlashChoice, SlashOption } from 'discordx';
import { Logger } from 'tslog';
import {
  BOT_COMMANDS_CHANNEL_ID,
  DISCUSSION_JOIN_CHANNEL_ID,
  DISCUSSION_JOIN_MESSAGE_ID,
  INTEREST_JOIN_CHANNEL_ID,
  INTEREST_JOIN_MESSAGE_ID,
  SERVER_ROLES,
} from '../constants';
import { discordCommandWrapper } from '../util/discord';
import { capitalize } from '../util/strings';

// TODO: Move implementation into lib
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

const logger = new Logger({ name: 'CreateChannel' });

const strings = {
  duplicateChannel: 'Channel with same name and emoji already exists!',
  success: 'Channel is done!',
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
  description: 'Create channel',
};

@Discord()
export class CreateChannel {
  @Slash({
    name: 'create_channel',
    description: strings.description,
  })
  async createchannel(
    @SlashOption({
      name: 'channel_name',
      description: strings.options.channelName.description,
      type: ApplicationCommandOptionType.String,
    })
    channelName: string,

    @SlashOption({
      name: 'channel_emoji',
      description: strings.options.channelEmoji.description,
      type: ApplicationCommandOptionType.String,
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
    @SlashOption({
      name: 'channel_category',
      description: strings.options.joinChannel.description,
      type: ApplicationCommandOptionType.String,
    })
    channelCategory: string,

    interaction: CommandInteraction
  ) {
    await discordCommandWrapper(interaction, async () => {
      logger.info(
        `Creating channel ${channelName} and associated channel role`
      );
      const fullChannelName = channelEmoji + channelName;

      logger.info('Checking for duplicate channels');
      if (
        interaction.guild.channels.cache.find(
          (channel) => channel.name === fullChannelName
        ) != null
      ) {
        logger.error(`Duplicate channel was found, aborting command`);
        await interaction.editReply({
          content: strings.duplicateChannel,
        });
        return;
      }

      // // TODO: check if second option is really just an emoji

      logger.info('Creating associated channel role');
      const channelRole = await interaction.guild.roles
        .create({
          name: capitalize(channelName),
        })
        .then((role) => role.setPermissions(0n)); // Clear permissions

      const channelInformation =
        strings.choices.channelCategory[
          channelCategory as keyof typeof strings.choices.channelCategory
        ];

      logger.info('Creating channel');
      const joinChannel = await interaction.guild.channels.fetch(
        channelInformation.channelId
      );
      const channel = await interaction.guild.channels.create({
        name: fullChannelName,
        parent: joinChannel.parentId,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          {
            id: interaction.guildId,
            deny: [PermissionsBitField.Flags.ViewChannel],
          },
          {
            id: channelRole.id,
            allow: [PermissionsBitField.Flags.ViewChannel],
          },
          {
            id: SERVER_ROLES.bots,
            allow: [PermissionsBitField.Flags.ViewChannel],
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
      await botCommandsChannel.send(
        `z/channel ${channelInformation.channelId}`
      );
      await botCommandsChannel.send(
        `z/message ${channelInformation.messageId}`
      );
      await botCommandsChannel.send(`z/add ${channelEmoji} ${channelName}`);

      logger.info(
        `Channel ${channel.toString()} and associated channel role ${channelRole.toString()} is deleted`
      );
      await interaction.editReply({
        content: strings.success,
      });
    });
  }
}

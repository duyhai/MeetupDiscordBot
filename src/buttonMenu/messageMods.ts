import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  CommandInteraction,
  MessageActionRowComponentBuilder,
  MessageFlags,
  ThreadAutoArchiveDuration,
  User,
} from 'discord.js';
import { ButtonComponent, Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import { SERVER_ROLES } from '../constants';
import { discordCommandWrapper } from '../util/discord';

const logger = new Logger({ name: 'MessageModsCommands' });

const MESSAGE_MOD_BUTTON_ID = 'message_mods';

@Discord()
export class MessageModsCommands {
  messageModsButton() {
    const messageModsButton = new ButtonBuilder()
      .setLabel('Message Mods')
      .setEmoji('📨')
      .setStyle(ButtonStyle.Primary)
      .setCustomId(MESSAGE_MOD_BUTTON_ID);

    const buttonRow =
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        messageModsButton,
      );
    return buttonRow;
  }

  async createThreadForUser(
    interaction: ButtonInteraction | CommandInteraction,
    user: User,
  ) {
    const { channel, guild } = interaction;

    if (channel.type !== ChannelType.GuildText) {
      return;
    }
    const guildMember = await guild.members.fetch(user.id);
    const threadName = `DM: ${guildMember.nickname || user.displayName} (${
      user.username
    })`;
    logger.info(`Looking for existing threads ${threadName}`);

    await channel.threads.fetchArchived({ fetchAll: true }, true);
    let thread = channel.threads.cache.find((t) => t.name === threadName);
    if (thread) {
      // Cannot use follow up, because we cannot change ephemeral state for follow up messages
      // https://github.com/discordjs/discord.js/issues/5702
      await interaction.followUp({
        content: `Private message thread already exists at ${thread.toString()}`,
        ephemeral: true,
      });
      logger.info(
        `Private message thread already exists at ${thread.toString()}`,
      );
      await thread.setArchived(false);
    } else {
      thread = await channel.threads.create({
        name: threadName,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        type: ChannelType.PrivateThread,
      });

      await interaction.followUp({
        content: `Private message thread created at ${thread.toString()}`,
        ephemeral: true,
      });
      logger.info(`Private message thread created at ${thread.toString()}`);
    }

    const moderatorRole = guild.roles.cache.find(
      (role) => role.id === SERVER_ROLES.moderator,
    );
    await thread.send({
      content: `${moderatorRole.toString()} ${user.toString()}`,
      flags: [MessageFlags.SuppressNotifications],
    });
  }

  @ButtonComponent({ id: MESSAGE_MOD_BUTTON_ID })
  async messageModsEventHandler(interaction: ButtonInteraction) {
    await discordCommandWrapper(interaction, async () => {
      logger.info(
        `Creating private message thread for ${interaction.user.username}`,
      );

      await this.createThreadForUser(interaction, interaction.user);
    });
  }

  @Slash({
    name: 'create_mod_message_button',
    description: `Creates a button that users can use to message mods`,
  })
  async createModMessageButtonHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      logger.info(
        `Creating mod messages button on behalf of ${interaction.user.username}`,
      );

      const replyContent = [
        `**Send a private message to our Moderator Team. We're here to help!**\n`,
        `Clicking the button below will create a private message thread only visible to you and the Moderator Team.\n`,
        `Please use this feature instead of reaching out individually.`,
        `Your inquiry will be addressed within 48 hours. Thank you for your cooperation!`,
      ];
      await interaction.channel.send({
        content: replyContent.join('\n'),
        components: [this.messageModsButton()],
      });
      logger.info(`Created mod messages button`);
    });
  }

  @Slash({
    name: 'mod_message_user',
    description: `Creates a mod message private thread including a user`,
  })
  async modMessageUserHandler(
    @SlashOption({
      name: 'user',
      description: 'User to DM',
      type: ApplicationCommandOptionType.User,
      required: true,
    })
    user: User,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      const fetchedUser = await interaction.client.users.fetch(user.id);
      logger.info(
        `Creating private message thread for ${fetchedUser.username}`,
      );

      await this.createThreadForUser(interaction, fetchedUser);
    });
  }
}

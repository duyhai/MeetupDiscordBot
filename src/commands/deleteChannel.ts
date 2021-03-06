import decamelize from 'decamelize';
import { CommandInteraction, Role, TextChannel } from 'discord.js';
import { Discord, Permission, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';
import { commandNames, MODERATOR_ROLE_ID } from '../constants';

const strings = {
  wrongChannelCategory: '',
  roleNotFound:
    'Associated channel role was not found! Please pass in a role explicitly!',
  success: 'Channel and associated channel role is deleted!',
  options: {
    channel: {
      name: 'channel',
      description: 'The channel you want to delete.',
    },
    channelRole: {
      name: 'channel_role',
      description: 'The channel role you want to delete.',
    },
  },
};

const logger = new Logger({ name: 'DeleteChannel' });

@Discord()
export class DeleteChannel {
  @Permission(false)
  @Permission({ id: MODERATOR_ROLE_ID, type: 'ROLE', permission: true })
  @Slash(commandNames.channel.delete)
  async deletechannel(
    @SlashOption(strings.options.channel.name, {
      description: strings.options.channel.description,
    })
    channel: TextChannel,
    @SlashOption(strings.options.channelRole.name, {
      description: strings.options.channelRole.description,
      required: false,
    })
    channelRole: Role | undefined,
    interaction: CommandInteraction
  ): Promise<void> {
    logger.info(
      `Deleting channel ${channel.name} and associated channel role ${channelRole?.name}`
    );
    let deletableRole: Role = channelRole;
    if (!channelRole) {
      logger.warn(
        `Channel role was not specified, searching for associated channel role`
      );
      channel.permissionOverwrites.cache.forEach((overwrite) => {
        const role = interaction.guild.roles.cache.get(overwrite.id);
        if (
          channel.name
            .toLowerCase()
            .includes(decamelize(role.name, { separator: '-' }))
        ) {
          logger.info(`Associated channel role was found: ${role.name}`);
          deletableRole = role;
        }
      });
    }
    if (!deletableRole) {
      logger.error(`Associated channel role not found, aborting command`);
      await interaction.reply({
        ephemeral: true,
        content: strings.roleNotFound,
      });
      return;
    }
    await deletableRole.delete();
    await channel.delete();

    logger.info(
      `Channel ${channel.name} and associated channel role ${deletableRole.name} is deleted`
    );
    await interaction.reply({
      ephemeral: true,
      content: strings.success,
    });
  }
}

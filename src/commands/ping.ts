import { CommandInteraction } from 'discord.js';
import { Discord, Permission, Slash } from 'discordx';
import { MODERATOR_ROLE_ID } from '../constants';

@Discord()
export class Ping {
  @Permission(false)
  @Permission({ id: MODERATOR_ROLE_ID, type: 'ROLE', permission: true })
  @Slash('ping')
  async createchannel(interaction: CommandInteraction) {
    await interaction.reply({
      ephemeral: true,
      content: 'Pong!',
    });
  }
}

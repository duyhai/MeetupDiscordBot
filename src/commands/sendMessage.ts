import {
  ApplicationCommandOptionType,
  CommandInteraction,
  MessageFlags,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';
import { discordCommandWrapper } from '../util/discord';

const logger = new Logger({ name: 'SendMessageCommands' });

@Discord()
export class SendMessageCommands {
  @Slash({
    name: 'send_message',
    description: 'Send message on behalf of Meetup Bot',
  })
  async sendMessageHandler(
    @SlashOption({
      name: 'message',
      description: 'The content of the message you want to send',
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    message: string,
    @SlashOption({
      name: 'is_silent',
      description:
        'Make mentions silent (highlights messages, but suppresses notifications)',
      type: ApplicationCommandOptionType.Boolean,
    })
    isSilent: boolean,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      logger.info(
        `${interaction.user.username} is sending a message via Meetup Bot: ${message}`,
      );
      await interaction.channel.send({
        content: message,
        flags: isSilent ? [MessageFlags.SuppressNotifications] : [],
      });
    });
  }
}

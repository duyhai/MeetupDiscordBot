import { BaseCommandInteraction, Client } from 'discord.js';
import { Logger } from 'tslog';
import { Command } from './interface';

const logger = new Logger({ name: 'OnboardUser' });

const OnboardUser: Command = {
  name: 'onboard_user',
  description: 'Returns a greeting',
  type: 'CHAT_INPUT',
  run: async (client: Client, interaction: BaseCommandInteraction) => {
    const content = 'Hello there!';

    interaction.followUp({
      ephemeral: true,
      content,
    }).catch((error) => logger.error(error));
  },
};

export default OnboardUser;

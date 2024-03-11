import { CommandInteraction } from 'discord.js';
import { Discord, Slash } from 'discordx';
import { Logger } from 'tslog';
import { LGBTQ_CHANNEL_ID } from '../constants';
import { addToChannel } from '../lib/helpers/channel';
import { discordCommandWrapper } from '../util/discord';

const logger = new Logger({ name: 'OnboardUserCommands' });

@Discord()
export class OnboardUserCommands {
  @Slash({
    name: 'taste_the_rainbow',
    description: 'Self onboard to LGTBQ channel. Output is private.',
  })
  async onboardLGBTQUserHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      logger.info(`Adding ${interaction.user.username} to the LGBTQ channel`);
      await addToChannel(interaction, LGBTQ_CHANNEL_ID);
    });
  }
}

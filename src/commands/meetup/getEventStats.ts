import { CommandInteraction } from 'discord.js';
import { Discord, Slash } from 'discordx';
import { Logger } from 'tslog';

import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

const logger = new Logger({ name: 'MeetupGetStatsCommands' });

@Discord()
export class MeetupGetEventStatsCommands {
  @Slash({
    name: 'meetup_get_event_stats',
    description: `Getting event stats from Meetup`,
  })
  async meetupGetStatsHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        logger.info('Getting data');
        const pastEvents = await meetupClient.getPastEvents();
        await interaction.editReply({ content: JSON.stringify(pastEvents) });
      });
    });
  }
}

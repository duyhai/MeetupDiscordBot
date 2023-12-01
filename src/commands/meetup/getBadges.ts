import { CommandInteraction } from 'discord.js';
import { Discord, Slash } from 'discordx';
import { getBadges } from '../../lib/helpers/getBadges';

import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

@Discord()
export class MeetupGetBadgesCommands {
  @Slash({
    name: 'meetup_get_badges',
    description: `Getting Discord badges based on Meetup stats. Output is private.`,
  })
  async meetupGetBadgesHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        await getBadges(meetupClient, interaction);
      });
    });
  }
}

import { CommandInteraction } from 'discord.js';
import { Discord, Slash } from 'discordx';

import { selfOnboardUser } from '../../lib/helpers/onboardUser';
import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

@Discord()
export class MeetupSelfOnboardCommands {
  @Slash({
    name: 'meetup_self_onboard',
    description: `Self-service onboarding through the Meetup Bot. Output is private.`,
  })
  async meetupSelfOnboardHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        await selfOnboardUser(meetupClient, interaction);
      });
    });
  }
}

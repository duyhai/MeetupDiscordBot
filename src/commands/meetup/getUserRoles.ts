import { CommandInteraction } from 'discord.js';
import { Discord, Slash } from 'discordx';

import { getUserRoles } from '../../lib/helpers/getUserRoles';
import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

@Discord()
export class MeetupGetUserRolesCommands {
  @Slash({
    name: 'meetup_get_user_roles',
    description: `Getting Discord roles based on Meetup role. Output is private.`,
  })
  async meetupGetUserRolesHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        return getUserRoles(meetupClient, interaction);
      });
    });
  }
}

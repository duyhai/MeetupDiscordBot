import { CommandInteraction } from 'discord.js';
import { Discord, Slash } from 'discordx';

import { getUserRoles } from '../../lib/helpers/getUserRoles.js';
import { discordCommandWrapper } from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';

@Discord()
export class MeetupGetUserRolesCommands {
  @Slash({
    name: 'meetup_get_user_roles',
    description: `Getting Discord roles based on Meetup role. Output is private.`,
  })
  async meetupGetUserRolesHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        await getUserRoles(meetupClient, interaction);
      });
    });
  }
}

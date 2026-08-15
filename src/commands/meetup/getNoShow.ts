import { CommandInteraction } from 'discord.js';
import { Discord, Slash } from 'discordx';
import { Logger } from 'tslog';

import { replyStack } from '../../lib/messageStack/registry.js';
import { discordCommandWrapper } from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';

const logger = new Logger({ name: 'MeetupNoShowCommands' });

@Discord()
export class MeetupNoShowCommands {
  @Slash({
    name: 'meetup_get_no_show',
    description: `Getting No Show count from Meetup. Output is private.`,
  })
  async meetupGetUserRolesHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        logger.info(`Fetching no show count for ${interaction.user.username}`);
        const membershipInfo = await meetupClient.getUserMembershipInfo();

        replyStack(interaction).ephemeral.append({
          content: `Your no show count is ${membershipInfo.groupByUrlname.membershipMetadata.rsvpStats.noShowCount}.`,
          status: 'success',
        });
      });
    });
  }
}

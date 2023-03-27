import { CommandInteraction } from 'discord.js';
import { Discord, Slash } from 'discordx';
import { Logger } from 'tslog';
import Configuration from '../../configuration';
import { getPaginatedData } from '../../lib/client/meetup/paginationHelper';
import { addServerRole } from '../../lib/helpers/onboardUser';

import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

const logger = new Logger({ name: 'MeetupGetStatsCommands' });

@Discord()
export class MeetupGetUserRolesCommands {
  @Slash({
    name: 'meetup_get_user_roles',
    description: `Getting Discord roles based on Meetup role. Output is private.`,
  })
  async meetupGetUserRolesHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        await interaction.editReply({
          content: 'Sit tight! Fetching data.',
        });

        const membershipInfo = await meetupClient.getUserMembershipInfo();
        if (!membershipInfo.groupByUrlname.isMember) {
          logger.warn(
            `Non-member user failed to get user roles. 
            Membership info: ${JSON.stringify(membershipInfo)}`
          );
          await interaction.editReply(
            `You're not a member on Meetup. Please join the group and try again`
          );
        }

        if (membershipInfo.groupByUrlname.isOrganizer) {
          await addServerRole(
            interaction.guild,
            interaction.user.id,
            'organizer'
          );
          await addServerRole(
            interaction.guild,
            interaction.user.id,
            'moderator'
          );
          await addServerRole(
            interaction.guild,
            interaction.user.id,
            'guest_host'
          );
          logger.info(
            `Organizer, moderator, and guest host role added to: ${interaction.user.username}`
          );
        } else {
          const getUserHostedEvents = await getPaginatedData(
            async (paginationInput) => {
              const result = await meetupClient.getUserHostedEvents(
                paginationInput
              );
              return result.self.hostedEvents;
            }
          );
          const didUserHostInGroup = getUserHostedEvents.some(
            (event) => event.group.id === Configuration.meetup.groupId
          );
          if (didUserHostInGroup) {
            await addServerRole(
              interaction.guild,
              interaction.user.id,
              'guest_host'
            );
            logger.info(
              `Guest host role added to: ${interaction.user.username}`
            );
          }
        }
        await interaction.editReply(
          `Your Meetup roles are all set up based on your Meetup status! Let us know if they are not accurate.`
        );
      });
    });
  }
}

import { CommandInteraction } from 'discord.js';
import { Discord, Slash } from 'discordx';
import { Logger } from 'tslog';
import Configuration from '../../configuration';
import { RewardRoleLevels } from '../../constants';
import { getPaginatedData } from '../../lib/client/meetup/paginationHelper';
import { addRewardRole, removeRewardRole } from '../../lib/helpers/onboardUser';

import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

const logger = new Logger({ name: 'MeetupGetStatsCommands' });

@Discord()
export class MeetupGetBadgesCommands {
  @Slash({
    name: 'meetup_get_badges',
    description: `Getting Discord badges based on Meetup stats`,
  })
  async meetupGetBadgesHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        await interaction.editReply({
          content: 'Sit tight! Fetching data.',
        });
        const { guild, user } = interaction;

        const getUserHostedEvents = await getPaginatedData(
          async (paginationInput) => {
            const result = await meetupClient.getUserHostedEvents(
              paginationInput
            );
            return result.self.hostedEvents;
          }
        );
        const getUserAttendedEvents = await getPaginatedData(
          async (paginationInput) => {
            const result = await meetupClient.getUserAttendedEvents(
              paginationInput
            );
            return result.self.pastEvents;
          }
        );

        const hostedCount = getUserHostedEvents.filter(
          (event) => event.group.id === Configuration.meetup.groupId
        ).length;
        const attendedCount = getUserAttendedEvents.filter(
          (event) => event.group.id === Configuration.meetup.groupId
        ).length;
        logger.info(JSON.stringify({ hostedCount, attendedCount }));

        const levels: RewardRoleLevels[] = [1, 5, 20, 50, 100, 500];
        const hostingRewards = levels.filter((num) => hostedCount >= num);
        const attendanceRewards = levels.filter((num) => attendedCount >= num);
        logger.info(JSON.stringify({ hostingRewards, attendanceRewards }));

        await removeRewardRole(guild, user.id, 'hosting');
        await removeRewardRole(guild, user.id, 'attendance');

        await addRewardRole(guild, user.id, 'hosting', hostingRewards);
        await addRewardRole(guild, user.id, 'attendance', attendanceRewards);

        await interaction.editReply(
          `Your Discord badges are all set up based on your Meetup status! Let us know if they are not accurate.`
        );
      });
    });
  }
}

import { ButtonInteraction, CommandInteraction } from 'discord.js';
import { Logger } from 'tslog';
import { RewardRoleLevels } from '../../constants';
import { GqlMeetupClient } from '../client/meetup/gqlClient';
import { getPaginatedData } from '../client/meetup/paginationHelper';
import { addRewardRole, removeRewardRole } from './onboardUser';

const logger = new Logger({ name: 'getUserRoles' });

export async function getBadges(
  meetupClient: GqlMeetupClient,
  interaction: CommandInteraction | ButtonInteraction
) {
  logger.info(`Getting badges for ${interaction.user.username}`);
  await interaction.editReply({
    content: 'Sit tight! Fetching data.',
  });
  const { guild, user } = interaction;

  const userInfo = await meetupClient.getUserInfo();

  const pastEvents = await getPaginatedData(async (paginationInput) => {
    const result = await meetupClient.getGroupEvents(paginationInput, {
      status: ['PAST'],
    });
    return result.groupByUrlname.events;
  });

  const getUserHostedEvents = pastEvents.filter(({ eventHosts }) =>
    eventHosts.some(({ member: { id } }) => id === userInfo.self.id)
  );

  // TODO: Optimization opportunity. Filter to events that are after joinDate
  const getUserAttendedEvents = (
    await Promise.all(
      pastEvents.map((event) =>
        getPaginatedData(async (paginationInput) => {
          const result = await meetupClient.getEventRsvps(
            event.id,
            paginationInput,
            {
              rsvpStatus: ['YES', 'ATTENDED'],
            }
          );
          return result.event.rsvps;
        })
      )
    )
  ).filter((rsvps) =>
    rsvps.some(({ member }) => member.id === userInfo.self.id)
  );

  const hostedCount = getUserHostedEvents.length;
  const attendedCount = getUserAttendedEvents.length;
  logger.info(JSON.stringify({ hostedCount, attendedCount }));

  const levels: RewardRoleLevels[] = [500, 100, 50, 20, 5, 1];
  const hostingRewards = levels.find((num) => hostedCount >= num);
  const attendanceRewards = levels.find((num) => attendedCount >= num);
  logger.info(JSON.stringify({ hostingRewards, attendanceRewards }));

  await removeRewardRole(guild, user.id, 'hosting');
  await removeRewardRole(guild, user.id, 'attendance');

  await addRewardRole(guild, user.id, 'hosting', hostingRewards);
  await addRewardRole(guild, user.id, 'attendance', attendanceRewards);

  await interaction.followUp({
    content: `Added Discord badges based on Meetup activity! Hosted: ${hostedCount} Attended: ${attendedCount}`,
    ephemeral: true,
  });
}

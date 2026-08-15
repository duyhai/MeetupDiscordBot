import { ButtonInteraction, CommandInteraction } from 'discord.js';
import { Logger } from 'tslog';
import { RewardRoleLevels } from '../../constants.js';
import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { getPaginatedData } from '../client/meetup/paginationHelper.js';
import { replyStack } from '../messageStack/registry.js';
import { countAttendedEvents, countHostedEvents } from './eventStats.js';
import { addRewardRole, removeRewardRole } from './onboardUser.js';

const logger = new Logger({ name: 'getUserRoles' });

export async function getBadges(
  meetupClient: GqlMeetupClient,
  interaction: CommandInteraction | ButtonInteraction,
) {
  logger.info(`Getting badges for ${interaction.user.username}`);
  const progressId = replyStack(interaction).ephemeral.append({
    content: 'Sit tight! Fetching data.',
    status: 'pending',
  });
  const { guild, user } = interaction;

  const userInfo = await meetupClient.getUserInfo();

  const pastEvents = await getPaginatedData(async (paginationInput) => {
    const result = await meetupClient.getGroupEvents(paginationInput, {
      status: ['PAST'],
    });
    return result.groupByUrlname.events;
  });

  // TODO: Optimization opportunity. Filter to events that are after joinDate
  const rsvpsPerEvent = await Promise.all(
    pastEvents.map((event) =>
      getPaginatedData(async (paginationInput) => {
        const result = await meetupClient.getEventRsvps(
          event.id,
          paginationInput,
          {
            rsvpStatus: ['YES', 'ATTENDED'],
          },
        );
        return result.event.rsvps;
      }),
    ),
  );

  const hostedCount = countHostedEvents(pastEvents, userInfo.self.id);
  const attendedCount = countAttendedEvents(rsvpsPerEvent, userInfo.self.id);
  logger.info(JSON.stringify({ hostedCount, attendedCount }));

  const levels: RewardRoleLevels[] = [500, 100, 50, 20, 5, 1];
  const hostingRewards = levels.find((num) => hostedCount >= num);
  const attendanceRewards = levels.find((num) => attendedCount >= num);
  logger.info(JSON.stringify({ hostingRewards, attendanceRewards }));

  await removeRewardRole(guild, user.id, 'hosting');
  await removeRewardRole(guild, user.id, 'attendance');

  await addRewardRole(guild, user.id, 'hosting', hostingRewards);
  await addRewardRole(guild, user.id, 'attendance', attendanceRewards);

  replyStack(interaction).ephemeral.remove(progressId);
  replyStack(interaction).ephemeral.append({
    content: `Added Discord badges based on Meetup activity! Hosted: ${hostedCount} Attended: ${attendedCount}`,
    status: 'success',
  });
}

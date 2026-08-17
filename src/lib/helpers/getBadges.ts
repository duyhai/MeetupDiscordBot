import { ButtonInteraction, CommandInteraction } from 'discord.js';
import { Logger } from 'tslog';
import { RewardRoleLevels } from '../../constants.js';
import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { BadgeCounts, getBadgeCounts } from './badgeCounts.js';
import { syncRewardRoles } from './onboardUser.js';

const logger = new Logger({ name: 'getUserRoles' });

/**
 * Applies the activity badges and reports the counts behind them, so the
 * caller can fold them into one summary.
 */
export async function getBadges(
  meetupClient: GqlMeetupClient,
  interaction: CommandInteraction | ButtonInteraction,
): Promise<BadgeCounts> {
  logger.info(`Getting badges for ${interaction.user.username}`);
  const { guild, user } = interaction;

  const { hostedCount, attendedCount } = await getBadgeCounts(meetupClient);
  logger.info(JSON.stringify({ hostedCount, attendedCount }));

  const levels: RewardRoleLevels[] = [500, 100, 50, 20, 5, 1];
  const hostingRewards = levels.find((num) => hostedCount >= num);
  const attendanceRewards = levels.find((num) => attendedCount >= num);
  logger.info(JSON.stringify({ hostingRewards, attendanceRewards }));

  await syncRewardRoles(guild, user.id, {
    hosting: hostingRewards,
    attendance: attendanceRewards,
  });

  return { hostedCount, attendedCount };
}

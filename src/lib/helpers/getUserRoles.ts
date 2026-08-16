import { ButtonInteraction, CommandInteraction } from 'discord.js';
import { Logger } from 'tslog';
import { GUEST_HOST_BLACKLIST } from '../../constants.js';
import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { getPaginatedData } from '../client/meetup/paginationHelper.js';
import { addServerRole } from './onboardUser.js';

const logger = new Logger({ name: 'getUserRoles' });

/**
 * Grants the Meetup-derived server roles and reports which ones were added,
 * so the caller can fold them into one summary rather than each step
 * announcing itself.
 */
export async function getUserRoles(
  meetupClient: GqlMeetupClient,
  interaction: CommandInteraction | ButtonInteraction,
): Promise<string[]> {
  const rolesGranted: string[] = [];
  logger.info(`Getting user roles for ${interaction.user.username}`);

  const membershipInfo = await meetupClient.getUserMembershipInfo();
  if (!membershipInfo.groupByUrlname.isMember) {
    logger.warn(
      `Non-member user failed to get user roles. 
      Membership info: ${JSON.stringify(membershipInfo)}`,
    );
    throw new Error(
      `You're not a member on Meetup. Please join the group and try onboarding again`,
    );
  }

  const isBlacklisted = GUEST_HOST_BLACKLIST.includes(interaction.user.id);

  if (
    !isBlacklisted &&
    membershipInfo.groupByUrlname.membershipMetadata.status === 'LEADER'
  ) {
    await addServerRole(interaction.guild, interaction.user.id, 'organizer');
    rolesGranted.push('Organizer');

    await addServerRole(interaction.guild, interaction.user.id, 'guest_host');
    rolesGranted.push('Guest Host');
    logger.info(
      `Organizer and guest host roles added to: ${interaction.user.username}`,
    );
  } else if (!isBlacklisted) {
    const userInfo = await meetupClient.getUserInfo();
    const getUserHostedEvents = await getPaginatedData(
      async (paginationInput) => {
        const result = await meetupClient.getGroupEvents(paginationInput, {
          status: ['PAST'],
          hostId: userInfo.self.id,
        });
        return result.groupByUrlname.events;
      },
    );

    logger.info(
      `Number of hosted events by ${interaction.user.username}: ${getUserHostedEvents.length}`,
    );
    if (getUserHostedEvents.length > 0) {
      await addServerRole(interaction.guild, interaction.user.id, 'guest_host');
      rolesGranted.push('Guest Host');
      logger.info(`Guest host role added to: ${interaction.user.username}`);
    }
  }
  return rolesGranted;
}

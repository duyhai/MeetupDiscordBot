import { Logger } from 'tslog';
import { GUEST_HOST_BLACKLIST } from '../../constants.js';
import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { getPaginatedData } from '../client/meetup/paginationHelper.js';
import { addServerRole } from './onboardUser.js';
import { VerifyContext } from './verifyContext.js';

const logger = new Logger({ name: 'getUserRoles' });

/**
 * Grants the Meetup-derived server roles and reports which ones were added,
 * so the caller can fold them into one summary rather than each step
 * announcing itself.
 */
export async function getUserRoles(
  meetupClient: GqlMeetupClient,
  {
    guild,
    userId,
    username,
  }: Pick<VerifyContext, 'guild' | 'userId' | 'username'>,
): Promise<string[]> {
  const rolesGranted: string[] = [];
  logger.info(`Getting user roles for ${username}`);

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

  const isBlacklisted = GUEST_HOST_BLACKLIST.includes(userId);

  if (
    !isBlacklisted &&
    membershipInfo.groupByUrlname.membershipMetadata.status === 'LEADER'
  ) {
    await addServerRole(guild, userId, 'organizer');
    rolesGranted.push('Organizer');

    await addServerRole(guild, userId, 'guest_host');
    rolesGranted.push('Guest Host');
    logger.info(`Organizer and guest host roles added to: ${username}`);
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
      `Number of hosted events by ${username}: ${getUserHostedEvents.length}`,
    );
    if (getUserHostedEvents.length > 0) {
      await addServerRole(guild, userId, 'guest_host');
      rolesGranted.push('Guest Host');
      logger.info(`Guest host role added to: ${username}`);
    }
  }
  return rolesGranted;
}

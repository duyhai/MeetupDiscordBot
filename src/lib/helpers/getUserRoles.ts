import { CommandInteraction } from 'discord.js';
import { Logger } from 'tslog';
import { GqlMeetupClient } from '../client/meetup/gqlClient';
import { getPaginatedData } from '../client/meetup/paginationHelper';
import { addServerRole } from './onboardUser';

const logger = new Logger({ name: 'getUserRoles' });

export async function getUserRoles(
  meetupClient: GqlMeetupClient,
  interaction: CommandInteraction
) {
  logger.info(`Getting user roles for ${interaction.user.username}`);
  await interaction.editReply({
    content: 'Sit tight! Fetching data.',
  });

  const membershipInfo = await meetupClient.getUserMembershipInfo();
  if (!membershipInfo.groupByUrlname.isMember) {
    logger.warn(
      `Non-member user failed to get user roles. 
      Membership info: ${JSON.stringify(membershipInfo)}`
    );
    throw new Error(
      `You're not a member on Meetup. Please join the group and try onboarding again`
    );
  }

  if (membershipInfo.groupByUrlname.isOrganizer) {
    await addServerRole(interaction.guild, interaction.user.id, 'organizer');
    await addServerRole(interaction.guild, interaction.user.id, 'moderator');
    await addServerRole(interaction.guild, interaction.user.id, 'guest_host');
    logger.info(
      `Organizer, moderator, and guest host role added to: ${interaction.user.username}`
    );
  } else {
    const userInfo = await meetupClient.getUserInfo();

    const pastEvents = await getPaginatedData(async (paginationInput) => {
      const result = await meetupClient.getPastGroupEvents(paginationInput);
      return result.groupByUrlname.pastEvents;
    });

    const getUserHostedEvents = pastEvents.filter(({ hosts }) =>
      hosts.some(({ id }) => id === userInfo.self.id)
    );
    logger.info(
      `Number of hosted events by ${interaction.user.username}: ${getUserHostedEvents.length}`
    );
    if (getUserHostedEvents.length > 0) {
      await addServerRole(interaction.guild, interaction.user.id, 'guest_host');
      logger.info(`Guest host role added to: ${interaction.user.username}`);
    }
  }
  await interaction.followUp({
    content: `Your Meetup roles are all set up based on your Meetup status! Let us know if they are not accurate.`,
    ephemeral: true,
  });
}

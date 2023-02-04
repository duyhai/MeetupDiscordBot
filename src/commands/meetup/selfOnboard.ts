import { ApplicationCommandOptionType, CommandInteraction } from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import Configuration from '../../configuration';
import { selfOnboardUser } from '../../lib/helpers/onboardUser';
import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

const logger = new Logger({ name: 'AuthUserCommands' });

@Discord()
export class MeetupSelfOnboardCommands {
  @Slash({
    name: 'meetup_self_onboard',
    description: `Self-service onboarding through the Meetup Bot. `,
  })
  async meetupSelfOnboardHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        const userInfo = await meetupClient.getUserInfo();

        const isMeetupGroupMember = userInfo.self.memberships.edges.some(
          (groupInfo) => groupInfo.node.id === Configuration.meetup.groupId
        );

        if (!isMeetupGroupMember) {
          logger.warn(
            `Non-member user failed to onboard: ${interaction.user.username}`
          );
          await interaction.reply(
            `You're not a member on Meetup. Please join the group and try onboarding again`
          );
          return;
        }

        const { name } = userInfo.self;
        const cleanedName = name
          .split(' ')
          .map((namePart, index) => {
            if (index === 0) {
              return namePart;
            }
            return `${namePart.at(0)}.`;
          })
          .join(' ');

        await selfOnboardUser(
          interaction,
          cleanedName,
          userInfo.self.gender === 'FEMALE'
        );
      });
    });
  }
}

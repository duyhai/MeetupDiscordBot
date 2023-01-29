import { ApplicationCommandOptionType, CommandInteraction } from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';
import Configuration, {
  DISCORD_BOT_MEETUP_OAUTH_URL,
} from '../../configuration';
import { GqlMeetupClient } from '../../lib/client/meetup/gqlClient';
import { selfOnboardUser } from '../../lib/helpers/user/onboard';

const logger = new Logger({ name: 'AuthUserCommands' });

@Discord()
export class AuthUserCommands {
  @Slash({
    name: 'meetup_get_auth_token',
    description: `Get a Meetup Auth token.`,
  })
  async meetupGetAuthTokenHandler(interaction: CommandInteraction) {
    await interaction.reply(
      `Please click on this link to get your Meetup Auth token: ${DISCORD_BOT_MEETUP_OAUTH_URL}`
    );
  }

  @Slash({
    name: 'meetup_self_onboard',
    description: `Self-service onboarding through the Meetup Bot. `,
  })
  async meetupSelfOnboardHandler(
    @SlashOption({
      name: 'token',
      description:
        'Meetup Auth token you can get with the /meetup_get_auth_token command',
      type: ApplicationCommandOptionType.String,
    })
    token: string,
    interaction: CommandInteraction
  ) {
    const client = new GqlMeetupClient(token);
    const userInfo = await client.getUserInfo();

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
  }
}

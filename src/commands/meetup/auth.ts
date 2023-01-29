import { ApplicationCommandOptionType, CommandInteraction } from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';
import Configuration, {
  DISCORD_BOT_MEETUP_OAUTH_URL,
} from '../../configuration';
import { GqlMeetupClient } from '../../lib/client/meetup/gqlClient';
import { onboardUser } from '../../lib/user/onboard';

const logger = new Logger({ name: 'AuthUserCommands' });

@Discord()
export class AuthUserCommands {
  @Slash({
    name: 'meetup_get_auth_token',
    description: `Get a Meetup Auth token.`,
    // The token is required for Meetup bot commands \
    // and is only active for an hour. Once it expires, \
    // you need to get a new token with this command again.`,
  })
  async meetupGetAuthTokenHandler(interaction: CommandInteraction) {
    await interaction.reply(
      `Please click on this link to get your Meetup Auth token: ${DISCORD_BOT_MEETUP_OAUTH_URL}`
    );
  }

  @Slash({
    name: 'meetup_self_onboard',
    description: `Self-service onboarding through the Meetup Bot. `,
    // You need to first get an auth token with /meetup_get_auth_token \
    // then use that token with this command. Example: \
    // /meetup_self_onboard <your_token_number>`,
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
    await interaction.deferReply();
    const client = new GqlMeetupClient(token);
    const userInfo = await client.getUserInfo();
    if (
      userInfo.self.memberships.edges.some(
        (groupInfo) => groupInfo.node.id === Configuration.meetup.groupId
      )
    ) {
      await onboardUser(
        interaction,
        interaction.user.id,
        userInfo.self.gender === 'FEMALE'
      );
    } else {
      logger.warn(
        `Non-member user failed to onboard: ${interaction.user.username}`
      );
      await interaction.editReply(
        `You're not a member on Meetup. Please join the group and try onboarding again`
      );
    }
  }
}

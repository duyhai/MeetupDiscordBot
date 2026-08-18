import { CommandInteraction } from 'discord.js';
import { Discord, Slash } from 'discordx';
import { Tokens } from '../../lib/client/discord/types.js';
import { ApplicationCache } from '../../util/cache.js';
import { discordCommandWrapper, hasAnyServerRole } from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';

@Discord()
export class MeetupGetTokenCommands {
  @Slash({
    name: 'meetup_get_token',
    description: `Get your Meetup access token (sent privately). Useful for notebooks/scripts.`,
  })
  async meetupGetTokenHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (_meetupClient) => {
        const tokenKey = `${interaction.user.id}-meetup-tokens`;
        const cache = await ApplicationCache();
        const rawTokens = await cache.get(tokenKey);

        if (!rawTokens) {
          throw new Error(
            '❌ No Meetup token found. Press **Link Meetup Account** in the ' +
              'get-verified channel to connect your Meetup account first.',
          );
        }

        const tokens = JSON.parse(rawTokens) as Tokens;

        const expiresInfo = tokens.expiresAt
          ? `\n⏰ Expires: <t:${Math.floor(tokens.expiresAt / 1000)}:R>`
          : '';

        const isOrganizer = hasAnyServerRole(
          await interaction.guild.members.fetch(interaction.user.id),
          ['moderator', 'organizer'],
        );
        // Only an organizer sees the refresh token: it is the long-lived
        // credential behind the whole Meetup-side sweep, so surfacing it to
        // every member who runs this command would hand out a standing
        // password with no way to tell who holds a copy.
        const refreshSection =
          isOrganizer && tokens.refreshToken
            ? [
                '',
                '🔁 **Refresh token** — long-lived, unlike the access token above.',
                'Set this as `MEETUP_ORGANIZER_REFRESH_TOKEN` in Heroku config to',
                'enable Meetup-side identity monitoring. Treat it as a password:',
                'it does not expire until revoked.',
                '```',
                tokens.refreshToken,
                '```',
              ]
            : [];

        await interaction.followUp({
          ephemeral: true,
          content: [
            '🔑 **Your Meetup Access Token** (keep this private!)',
            '```',
            tokens.accessToken,
            '```',
            expiresInfo,
            '',
            '💡 Paste this into the `ACCESS_TOKEN` field in the analysis notebook.',
            ...refreshSection,
          ].join('\n'),
        });
      });
    });
  }
}

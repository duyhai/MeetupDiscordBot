import { CommandInteraction } from 'discord.js';
import { Discord, Slash } from 'discordx';
import { Tokens } from '../../lib/client/discord/types';
import { ApplicationCache } from '../../util/cache';
import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

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
            '❌ No Meetup token found. Please connect your Meetup account first using `/meetup_self_onboard` or another Meetup command.'
          );
        }

        const tokens = JSON.parse(rawTokens) as Tokens;

        const expiresInfo = tokens.expiresAt
          ? `\n⏰ Expires: <t:${Math.floor(tokens.expiresAt / 1000)}:R>`
          : '';

        await interaction.followUp({
          content: [
            '🔑 **Your Meetup Access Token** (keep this private!)',
            '```',
            tokens.accessToken,
            '```',
            expiresInfo,
            '',
            '💡 Paste this into the `ACCESS_TOKEN` field in the analysis notebook.',
          ].join('\n'),
        });
      });
    });
  }
}

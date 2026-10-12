import { ApplicationCommandOptionType, CommandInteraction } from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { forgetMeetupTokens } from '../../lib/helpers/meetupTokens.js';
import { ApplicationCache } from '../../util/cache.js';
import {
  discordCommandWrapper,
  hasAnyServerRole,
  isAdmin,
} from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';

@Discord()
export class MeetupGetTokenCommands {
  @Slash({
    name: 'meetup_get_token',
    description: `Get your Meetup access token (sent privately). Useful for notebooks/scripts.`,
  })
  async meetupGetTokenHandler(
    @SlashOption({
      name: 'sweep_credential',
      description:
        'Organizers only: also show the refresh token for identity monitoring, and disconnect you.',
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    })
    sweepCredential: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      // The set withMeetupClient resolved, not a second read of the cache:
      // if a refreshed set could not be stored, the cached pair is stale and
      // its access token is already dead.
      await withMeetupClient(interaction, async (_meetupClient, tokens) => {
        const expiresInfo = tokens.expiresAt
          ? `\n⏰ Expires: <t:${Math.floor(tokens.expiresAt / 1000)}:R>`
          : '';

        // `interaction.guild` is null when the command is invoked from a DM
        // -- which is a natural thing to do with a command whose whole
        // purpose is handing back a secret. Dereferencing it threw a
        // TypeError that surfaced as a generic "command failed", so a member
        // could not even retrieve their access token from a DM. No guild
        // means no role information, so the refresh token is simply withheld:
        // an unverifiable caller is not an organizer.
        const member = interaction.guild
          ? await interaction.guild.members.fetch(interaction.user.id)
          : undefined;
        // isAdmin alongside the role check, matching requireModOrOrganizer:
        // the server owner holds Administrator without necessarily holding
        // the organizer role, and they are the single person most likely to
        // be the one setting MEETUP_ORGANIZER_REFRESH_TOKEN in Heroku.
        const isOrganizer = Boolean(
          member &&
          (isAdmin(member) ||
            hasAnyServerRole(member, ['moderator', 'organizer'])),
        );
        // The refresh token is the long-lived credential behind the whole
        // Meetup-side sweep, so it is shown only when asked for and only to
        // an organizer. Asked for, because showing it also hands the
        // connection over (below): a routine call for an access token must
        // neither surface a standing password nor disconnect the caller.
        const handOver = Boolean(
          sweepCredential && isOrganizer && tokens.refreshToken,
        );
        const refreshSection = handOver
          ? [
              '',
              '🔁 **Refresh token** — long-lived, unlike the access token above.',
              'Set this as `MEETUP_ORGANIZER_REFRESH_TOKEN` in Heroku config to',
              'enable Meetup-side identity monitoring. Treat it as a password:',
              'it does not expire until revoked.',
              '```',
              tokens.refreshToken,
              '```',
              '⚠️ This connection has now been handed over: the bot has',
              'forgotten it so that the sweep is the only thing refreshing',
              'this grant, and you will be asked to connect again the next',
              'time you use a Meetup command. Only use a token from the',
              'dedicated monitoring Meetup account as the sweep credential,',
              'never one from an account that also runs Meetup commands.',
            ]
          : [];
        const declinedSection =
          sweepCredential && !handOver
            ? [
                '',
                'ℹ️ `sweep_credential` only applies to moderators and organizers',
                'running this command in the server, so no refresh token is shown.',
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
            ...declinedSection,
          ].join('\n'),
        });

        // Whoever was shown the refresh token may make it the sweep's
        // credential, and a grant must have exactly one refresher: if Meetup
        // rotates refresh tokens, this member's next command and the sweep
        // would each invalidate the other's copy. After the reply, so a
        // failed delivery does not cost them the connection.
        if (handOver) {
          await forgetMeetupTokens(
            await ApplicationCache(),
            interaction.user.id,
          );
        }
      });
    });
  }
}

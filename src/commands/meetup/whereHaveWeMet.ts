import {
  ApplicationCommandOptionType,
  CommandInteraction,
  GuildMember,
  User,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';

import {
  parseMeetupMemberId,
  replyWhereHaveWeMet,
} from '../../lib/helpers/whereHaveWeMet.js';
import { discordCommandWrapper } from '../../util/discord.js';

@Discord()
export class WhereHaveWeMetCommands {
  @Slash({
    name: 'where_have_we_met',
    description:
      'See the events you and someone else both went to. Output is private.',
  })
  async whereHaveWeMetHandler(
    // discordx passes a GuildMember when the person is on the server.
    @SlashOption({
      name: 'member',
      description: 'Someone on this Discord server.',
      type: ApplicationCommandOptionType.User,
      required: false,
    })
    member: GuildMember | User | undefined,
    @SlashOption({
      name: 'meetup_profile',
      description:
        'Or their Meetup profile link, for someone not on Discord or not linked yet.',
      type: ApplicationCommandOptionType.String,
      required: false,
    })
    meetupProfile: string | undefined,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      if ((member === undefined) === (meetupProfile === undefined)) {
        throw new Error('Give exactly one of `member` or `meetup_profile`.');
      }
      if (member) {
        await replyWhereHaveWeMet(
          interaction,
          { discordUserId: member.id },
          member.displayName,
        );
        return;
      }
      const meetupId = parseMeetupMemberId(meetupProfile);
      if (!meetupId) {
        throw new Error(
          'That doesn’t look like a Meetup profile link. It should look like https://www.meetup.com/members/123456789/',
        );
      }
      await replyWhereHaveWeMet(interaction, { meetupId }, 'them');
    });
  }
}

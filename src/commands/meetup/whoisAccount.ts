import {
  ApplicationCommandOptionType,
  CommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  User,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';

import {
  formatMemberFields,
  parseMeetupMemberId,
} from '../../lib/helpers/whois.js';
import { MemberRecord } from '../../lib/repositories/types.js';
import {
  discordCommandWrapper,
  hasAnyServerRole,
  isAdmin,
} from '../../util/discord.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';

const EMBED_COLOR = 0x3498db;

const strings = {
  notAllowed: 'Only moderators and organizers can look up member records.',
  exactlyOne: 'Provide exactly one of user or meetup.',
  badMeetupInput:
    "Couldn't parse a Meetup member ID from that input. Use a profile URL like https://www.meetup.com/members/123456/ or a numeric ID.",
  noRowForUser: (user: User) => `${user.toString()} has no member record.`,
  noRowForMeetup: 'No Discord account has linked that Meetup account.',
};

@Discord()
export class MeetupWhoisCommands {
  @Slash({
    name: 'meetup_whois',
    description:
      "Look up a member's linked Meetup account (mods/organizers only)",
    // Hides the command from members without mod permissions; the role check
    // inside the handler stays authoritative. Guild admins can re-grant
    // visibility per role under Server Settings → Integrations.
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async meetupWhoisHandler(
    @SlashOption({
      name: 'user',
      description: 'The Discord user to look up',
      type: ApplicationCommandOptionType.User,
      required: false,
    })
    user: User | undefined,
    @SlashOption({
      name: 'meetup',
      description: 'Meetup profile URL or member ID to look up',
      type: ApplicationCommandOptionType.String,
      required: false,
    })
    meetup: string | undefined,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (
        !isAdmin(member) &&
        !hasAnyServerRole(member, ['moderator', 'organizer'])
      ) {
        throw new Error(strings.notAllowed);
      }

      if ((user && meetup) || (!user && !meetup)) {
        throw new Error(strings.exactlyOne);
      }

      const repo = await ApplicationMemberRepository();
      let row: MemberRecord | undefined;
      if (user) {
        row = await repo.findByDiscordId(user.id);
        if (!row) {
          await interaction.followUp({
            content: strings.noRowForUser(user),
            ephemeral: true,
          });
          return;
        }
      } else {
        const meetupId = parseMeetupMemberId(meetup);
        if (!meetupId) {
          throw new Error(strings.badMeetupInput);
        }
        row = await repo.findByMeetupId(meetupId);
        if (!row) {
          await interaction.followUp({
            content: strings.noRowForMeetup,
            ephemeral: true,
          });
          return;
        }
      }

      const embed = new EmbedBuilder()
        .setTitle('Member lookup')
        .setColor(EMBED_COLOR)
        .addFields(formatMemberFields(row))
        .setTimestamp(new Date());
      await interaction.followUp({ embeds: [embed], ephemeral: true });
    });
  }
}

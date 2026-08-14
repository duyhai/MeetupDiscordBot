import {
  ApplicationCommandOptionType,
  CommandInteraction,
  PermissionFlagsBits,
  User,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';

import {
  whoisByDiscordUser,
  whoisByMeetupInput,
} from '../../lib/helpers/whois.js';
import {
  discordCommandWrapper,
  requireModOrOrganizer,
} from '../../util/discord.js';

const strings = {
  notAllowed: 'Only moderators and organizers can look up member records.',
};

// Hides the commands from members without mod permissions; the role check
// inside the handler stays authoritative. Guild admins can re-grant
// visibility per role under Server Settings → Integrations.
const MOD_ONLY_VISIBILITY = PermissionFlagsBits.ModerateMembers;

@Discord()
export class MeetupWhoisCommands {
  @Slash({
    name: 'meetup_whois_discorduser',
    description:
      "Look up a Discord member's linked Meetup account (mods/organizers only)",
    defaultMemberPermissions: MOD_ONLY_VISIBILITY,
  })
  async meetupWhoisUserHandler(
    @SlashOption({
      name: 'user',
      description: 'The Discord user to look up',
      type: ApplicationCommandOptionType.User,
      required: true,
    })
    user: User,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(interaction, strings.notAllowed);
      await whoisByDiscordUser(interaction, user.id);
    });
  }

  @Slash({
    name: 'meetup_whois_meetupuser',
    description:
      'Look up which Discord account claimed a Meetup profile (mods/organizers only)',
    defaultMemberPermissions: MOD_ONLY_VISIBILITY,
  })
  async meetupWhoisMeetupHandler(
    @SlashOption({
      name: 'meetup',
      description: 'Meetup profile URL or member ID to look up',
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    meetup: string,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(interaction, strings.notAllowed);
      await whoisByMeetupInput(interaction, meetup);
    });
  }
}

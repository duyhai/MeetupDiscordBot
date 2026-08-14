import {
  ApplicationCommandType,
  MessageContextMenuCommandInteraction,
  PermissionFlagsBits,
  UserContextMenuCommandInteraction,
} from 'discord.js';
import { ContextMenu, Discord } from 'discordx';

import { whoisByDiscordUser } from '../lib/helpers/whois.js';
import {
  discordCommandWrapper,
  requireModOrOrganizer,
} from '../util/discord.js';

const strings = {
  notAllowed: 'Only moderators and organizers can look up member records.',
};

/**
 * Right-click lookups for the Discord → Meetup direction: a user, or a
 * message (looks up the message author). Same gate as the slash commands.
 */
@Discord()
export class WhoisUserContextCommands {
  @ContextMenu({
    name: 'whois_meetup',
    type: ApplicationCommandType.User,
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async whoisUserCtxHandler(interaction: UserContextMenuCommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(interaction, strings.notAllowed);
      await whoisByDiscordUser(interaction, interaction.targetUser.id);
    });
  }

  @ContextMenu({
    name: 'whois_meetup',
    type: ApplicationCommandType.Message,
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async whoisMessageCtxHandler(
    interaction: MessageContextMenuCommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(interaction, strings.notAllowed);
      await whoisByDiscordUser(
        interaction,
        interaction.targetMessage.author.id,
      );
    });
  }
}

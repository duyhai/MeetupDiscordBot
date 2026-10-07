import {
  ApplicationCommandType,
  GuildMember,
  UserContextMenuCommandInteraction,
} from 'discord.js';
import { ContextMenu, Discord } from 'discordx';

import { replyWhereHaveWeMet } from '../lib/helpers/whereHaveWeMet.js';
import { discordCommandWrapper } from '../util/discord.js';

/** Right-click anyone → Apps → Where have we met? Open to every member. */
@Discord()
export class WhereHaveWeMetContextCommands {
  @ContextMenu({
    name: 'Where have we met?',
    type: ApplicationCommandType.User,
  })
  async whereHaveWeMetHandler(interaction: UserContextMenuCommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      const { targetUser, targetMember } = interaction;
      const name =
        (targetMember instanceof GuildMember
          ? targetMember.displayName
          : undefined) ??
        targetUser.globalName ??
        targetUser.username;
      await replyWhereHaveWeMet(
        interaction,
        { discordUserId: targetUser.id },
        name,
      );
    });
  }
}

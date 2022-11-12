import {
  ApplicationCommandType,
  MessageContextMenuCommandInteraction,
  UserContextMenuCommandInteraction,
} from 'discord.js';
import { ContextMenu, Discord } from 'discordx';
import { onboardUser } from '../../lib/user/onboard';

@Discord()
export class OnboardUserContextCommands {
  @ContextMenu({
    name: 'onboard_members',
    type: ApplicationCommandType.Message,
  })
  async onboardNonLadiesMsgHandler(
    interaction: MessageContextMenuCommandInteraction
  ) {
    const { targetMessage } = interaction;
    await onboardUser(interaction, targetMessage.author.id, false);
  }

  @ContextMenu({
    name: 'onboard_ladies',
    type: ApplicationCommandType.Message,
  })
  async onboardLadiesMsgHandler(
    interaction: MessageContextMenuCommandInteraction
  ) {
    const { targetMessage } = interaction;
    await onboardUser(interaction, targetMessage.author.id, true);
  }

  @ContextMenu({
    name: 'onboard_members',
    type: ApplicationCommandType.User,
  })
  async onboardNonLadiesUserHandler(
    interaction: UserContextMenuCommandInteraction
  ) {
    const { targetUser } = interaction;
    await onboardUser(interaction, targetUser.id, false);
  }

  @ContextMenu({
    name: 'onboard_ladies',
    type: ApplicationCommandType.User,
  })
  async onboardLadiesUserHandler(
    interaction: UserContextMenuCommandInteraction
  ) {
    const { targetUser } = interaction;
    await onboardUser(interaction, targetUser.id, true);
  }
}

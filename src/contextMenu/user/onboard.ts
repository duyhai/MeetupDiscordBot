import {
  MessageContextMenuInteraction,
  UserContextMenuInteraction,
} from 'discord.js';
import { ContextMenu, Discord, Permission } from 'discordx';
import { commandNames, MODERATOR_ROLE_ID } from '../../constants';
import { onboardUser } from '../../lib/user/onboard';

@Discord()
export class OnboardUserContextCommands {
  @Permission(false)
  @Permission({ id: MODERATOR_ROLE_ID, type: 'ROLE', permission: true })
  @ContextMenu('MESSAGE', commandNames.user.onboardNonLadies)
  async onboardNonLadiesMsgHandler(interaction: MessageContextMenuInteraction) {
    const { targetMessage } = interaction;
    await onboardUser(interaction, targetMessage.author.id, false);
  }

  @Permission(false)
  @Permission({ id: MODERATOR_ROLE_ID, type: 'ROLE', permission: true })
  @ContextMenu('MESSAGE', commandNames.user.onboardLadies)
  async onboardLadiesMsgHandler(interaction: MessageContextMenuInteraction) {
    const { targetMessage } = interaction;
    await onboardUser(interaction, targetMessage.author.id, true);
  }

  @Permission(false)
  @Permission({ id: MODERATOR_ROLE_ID, type: 'ROLE', permission: true })
  @ContextMenu('USER', commandNames.user.onboardNonLadies)
  async onboardNonLadiesUserHandler(interaction: UserContextMenuInteraction) {
    const { targetUser } = interaction;
    await onboardUser(interaction, targetUser.id, false);
  }

  @Permission(false)
  @Permission({ id: MODERATOR_ROLE_ID, type: 'ROLE', permission: true })
  @ContextMenu('USER', commandNames.user.onboardLadies)
  async onboardLadiesUserHandler(interaction: UserContextMenuInteraction) {
    const { targetUser } = interaction;
    await onboardUser(interaction, targetUser.id, true);
  }
}

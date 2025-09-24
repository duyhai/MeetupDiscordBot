import {
  ApplicationCommandType,
  MessageContextMenuCommandInteraction,
  UserContextMenuCommandInteraction,
} from 'discord.js';
import { ContextMenu, Discord } from 'discordx';
import { onboardUser } from '../lib/helpers/onboardUser';
import { discordCommandWrapper } from '../util/discord';

const OnboardUserCommands = {
  onboardGents: 'onboard_gents',
  onboardLadies: 'onboard_ladies',
  onboardMembers: 'onboard_members',
};

@Discord()
export class OnboardUserContextCommands {
  @ContextMenu({
    name: OnboardUserCommands.onboardMembers,
    type: ApplicationCommandType.Message,
  })
  async onboardMembersMsgHandler(
    interaction: MessageContextMenuCommandInteraction
  ) {
    await discordCommandWrapper(interaction, async () => {
      const { targetMessage } = interaction;
      await onboardUser(interaction, targetMessage.author.id, 'OTHER');
    });
  }

  @ContextMenu({
    name: OnboardUserCommands.onboardLadies,
    type: ApplicationCommandType.Message,
  })
  async onboardLadiesMsgHandler(
    interaction: MessageContextMenuCommandInteraction
  ) {
    await discordCommandWrapper(interaction, async () => {
      const { targetMessage } = interaction;
      await onboardUser(interaction, targetMessage.author.id, 'FEMALE');
    });
  }

  @ContextMenu({
    name: OnboardUserCommands.onboardGents,
    type: ApplicationCommandType.Message,
  })
  async onboardGentsMsgHandler(
    interaction: MessageContextMenuCommandInteraction
  ) {
    await discordCommandWrapper(interaction, async () => {
      const { targetMessage } = interaction;
      await onboardUser(interaction, targetMessage.author.id, 'MALE');
    });
  }

  @ContextMenu({
    name: OnboardUserCommands.onboardMembers,
    type: ApplicationCommandType.User,
  })
  async onboardMembersUserHandler(
    interaction: UserContextMenuCommandInteraction
  ) {
    await discordCommandWrapper(interaction, async () => {
      const { targetUser } = interaction;
      await onboardUser(interaction, targetUser.id, 'OTHER');
    });
  }

  @ContextMenu({
    name: OnboardUserCommands.onboardLadies,
    type: ApplicationCommandType.User,
  })
  async onboardLadiesUserHandler(
    interaction: UserContextMenuCommandInteraction
  ) {
    await discordCommandWrapper(interaction, async () => {
      const { targetUser } = interaction;
      await onboardUser(interaction, targetUser.id, 'FEMALE');
    });
  }

  @ContextMenu({
    name: OnboardUserCommands.onboardGents,
    type: ApplicationCommandType.User,
  })
  async onboardGentsUserHandler(
    interaction: UserContextMenuCommandInteraction
  ) {
    await discordCommandWrapper(interaction, async () => {
      const { targetUser } = interaction;
      await onboardUser(interaction, targetUser.id, 'MALE');
    });
  }
}

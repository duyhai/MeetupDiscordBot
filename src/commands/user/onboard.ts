import { CommandInteraction, User } from 'discord.js';
import { Discord, Permission, Slash, SlashOption } from 'discordx';
import { commandNames, MODERATOR_ROLE_ID } from '../../constants';
import { onboardUser } from '../../lib/user/onboard';

const strings = {
  commandDescription: 'User to onboard',
};

@Discord()
export class OnboardUserCommands {
  @Permission(false)
  @Permission({ id: MODERATOR_ROLE_ID, type: 'ROLE', permission: true })
  @Slash(commandNames.user.onboardNonLadies)
  async onboardNonLadiesUserHandler(
    @SlashOption('user', {
      description: strings.commandDescription,
    })
    user: User,
    interaction: CommandInteraction
  ) {
    await onboardUser(interaction, user.id, false);
  }

  @Permission(false)
  @Permission({ id: MODERATOR_ROLE_ID, type: 'ROLE', permission: true })
  @Slash(commandNames.user.onboardLadies)
  async onboardLadiesUserHandler(
    @SlashOption('user', {
      description: strings.commandDescription,
    })
    user: User,
    interaction: CommandInteraction
  ) {
    await onboardUser(interaction, user.id, true);
  }
}

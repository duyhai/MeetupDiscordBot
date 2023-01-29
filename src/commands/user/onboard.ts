import {
  ApplicationCommandOptionType,
  CommandInteraction,
  User,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { LGBTQ_CHANNEL_ID } from '../../constants';
import { addToChannel, onboardUser } from '../../lib/helpers/user/onboard';

const strings = {
  commandDescription: 'User to onboard',
};

@Discord()
export class OnboardUserCommands {
  @Slash({
    name: 'onboard_members',
    description: 'Onboard member',
  })
  async onboardNonLadiesUserHandler(
    @SlashOption({
      name: 'user',
      description: strings.commandDescription,
      type: ApplicationCommandOptionType.User,
    })
    user: User,
    interaction: CommandInteraction
  ) {
    await onboardUser(interaction, user.id, false);
  }

  @Slash({
    name: 'onboard_ladies',
    description: 'Onboard member with access to LadiesLounge',
  })
  async onboardLadiesUserHandler(
    @SlashOption({
      name: 'user',
      description: strings.commandDescription,
      type: ApplicationCommandOptionType.User,
    })
    user: User,
    interaction: CommandInteraction
  ) {
    await onboardUser(interaction, user.id, true);
  }

  @Slash({
    name: 'taste_the_rainbow',
    description: 'Self onboard to LGTBQ channel',
  })
  async onboardLGBTQUserHandler(interaction: CommandInteraction) {
    await addToChannel(interaction, LGBTQ_CHANNEL_ID);
  }
}

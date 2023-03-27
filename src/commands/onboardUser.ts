import {
  ApplicationCommandOptionType,
  CommandInteraction,
  User,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { LGBTQ_CHANNEL_ID } from '../constants';
import { addToChannel } from '../lib/helpers/channel';
import { onboardUser } from '../lib/helpers/onboardUser';
import { discordCommandWrapper } from '../util/discord';

const strings = {
  commandDescription: 'User to onboard',
};

@Discord()
export class OnboardUserCommands {
  @Slash({
    name: 'onboard_members',
    description: 'Onboard member. Output is public.',
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
    await discordCommandWrapper(interaction, async () => {
      await onboardUser(interaction, user.id, false);
    });
  }

  @Slash({
    name: 'onboard_ladies',
    description:
      'Onboard member with access to LadiesLounge. Output is private.',
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
    await discordCommandWrapper(interaction, async () => {
      await onboardUser(interaction, user.id, true);
    });
  }

  @Slash({
    name: 'taste_the_rainbow',
    description: 'Self onboard to LGTBQ channel. Output is private.',
  })
  async onboardLGBTQUserHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await addToChannel(interaction, LGBTQ_CHANNEL_ID);
    });
  }
}

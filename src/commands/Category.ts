import {BaseCommandInteraction, Client} from 'discord.js';
import {ApplicationCommandOptionTypes} from 'discord.js/typings/enums';
import {Command} from '../Command';

export const Testcat: Command = {
  name: 'testcat',
  description: 'Asd',
  type: 'CHAT_INPUT',
  options: [
    {
      name: 'channelid',
      description: 'Aasd.',
      required: true,
      type: ApplicationCommandOptionTypes.STRING,
    },
  ],
  run: async (client: Client, interaction: BaseCommandInteraction) => {
    const channelCategory = interaction.guild
        .channels.cache.get(interaction.options[0].value);
    console.log(channelCategory);

    const content = 'Check console!';
    await interaction.followUp({
      ephemeral: true,
      content,
    });
  },
};

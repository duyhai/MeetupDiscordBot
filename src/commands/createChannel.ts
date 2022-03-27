import {
  BaseCommandInteraction,
  CategoryChannel,
  Channel,
  Client,
  Guild,
  Permissions,
  Role,
  TextChannel,
} from 'discord.js';
import { ApplicationCommandOptionTypes } from 'discord.js/typings/enums';
import { Command } from './interface';

const zapierBotID = '368105370532577280';
const botCommandsChannelID = '935815028140015616';
const joinChannelID = '935080178181373992';
const messageID = '935080771536953394';

const CreateChannel: Command = {
  name: 'createchannel',
  description: 'Creates a new channel',
  type: 'CHAT_INPUT',
  options: [
    {
      name: 'channelname',
      description: 'Name of the new channel.',
      required: true,
      type: ApplicationCommandOptionTypes.STRING,
    },
    {
      name: 'channelemoji',
      description: 'Emoji for the channel.',
      required: true,
      type: ApplicationCommandOptionTypes.STRING,
    },
    {
      name: 'channelcategoryid',
      description: 'CategoryID of the channel.',
      required: true,
      type: ApplicationCommandOptionTypes.STRING,
    },
  ],

  run: async (client: Client, interaction: BaseCommandInteraction) => {
    const optionsArray = interaction.options.data;
    const channelName = optionsArray[0].value as string;
    const emoji = optionsArray[1].value as string;
    const categoryID = optionsArray[2].value as string;

    const category = await client.channels.fetch(categoryID).catch() as unknown as CategoryChannel;

    console.log(JSON.stringify((await client.guilds.fetch(interaction.guildId)).roles.cache));

    // if (category === undefined || category.type !== 'GUILD_CATEGORY') {
    //   await interaction.followUp({
    //     ephemeral: true,
    //     content: 'Error: category was not found!',
    //   });
    //   return;
    // }

    // const name = emoji + channelName;
    // if (interaction.guild.channels.cache.find(
    //   (c) => c.name.toLowerCase() === name,
    // ) !== undefined) {
    //   await interaction.followUp({
    //     ephemeral: true,
    //     content: 'Error: channel with this name already exists!',
    //   });
    //   return;
    // }

    // // TODO: check if second option is really just an emoji

    // const channel = await interaction.guild.channels.create(name, {
    //   type: 'GUILD_TEXT',
    // });
    // await channel.setParent(category);

    // const role = await interaction.guild.roles.create({
    //   name: channelName,
    // });
    // const zapierBot = await interaction.guild.members.fetch(zapierBotID);
    // await channel.permissionOverwrites.create(
    //   interaction.guild.roles.everyone, // sometimes it returns undefined for no reason
    //   { VIEW_CHANNEL: false },
    // );
    // await channel.permissionOverwrites.create(zapierBot, { VIEW_CHANNEL: true });
    // await channel.permissionOverwrites.create(role, { VIEW_CHANNEL: true });

    // const botCommandsChannel = interaction.guild.channels.cache
    //   .get(botCommandsChannelID) as TextChannel;
    // await botCommandsChannel.send(`z/channel ${joinChannelID}`);
    // await botCommandsChannel.send(`z/message ${messageID}`);
    // await botCommandsChannel.send(`z/add ${emoji} ${channelName}`);

    // await interaction.followUp({
    //   ephemeral: true,
    //   content: 'Channel is done!',
    // });
  },
};

export default CreateChannel;

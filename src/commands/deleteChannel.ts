// import decamelize from 'decamelize';
// import {
//   CommandInteraction,
//   Role,
//   TextChannel,
//   ApplicationCommandOptionType,
// } from 'discord.js';
// import { Discord, Slash, SlashOption } from 'discordx';
// import { Logger } from 'tslog';
// import { discordCommandWrapper } from '../util/discord';

// const strings = {
//   wrongChannelCategory: '',
//   roleNotFound:
//     'Associated channel role was not found! Please pass in a role explicitly!',
//   success: 'Channel and associated channel role is deleted!',
//   description: 'Delete channel',
//   options: {
//     channel: {
//       description: 'The channel you want to delete.',
//     },
//     channelRole: {
//       description: 'The channel role you want to delete.',
//     },
//   },
// };

// const logger = new Logger({ name: 'DeleteChannel' });

// // TODO: Move implementation into lib
// @Discord()
// export class DeleteChannel {
//   @Slash({
//     name: 'delete_channel',
//     description: strings.description,
//   })
//   async deleteChannel(
//     @SlashOption({
//       name: 'channel',
//       description: strings.options.channel.description,
//       type: ApplicationCommandOptionType.Channel,
//     })
//     channel: TextChannel,
//     @SlashOption({
//       name: 'channel_role',
//       description: strings.options.channelRole.description,
//       required: false,
//       type: ApplicationCommandOptionType.Role,
//     })
//     channelRole: Role | undefined,
//     interaction: CommandInteraction
//   ): Promise<void> {
//     await discordCommandWrapper(interaction, async () => {
//       logger.info(
//         `Deleting channel ${channel.name} and associated channel role ${channelRole?.name}`
//       );
//       let deletableRole: Role = channelRole;
//       if (!channelRole) {
//         logger.warn(
//           `Channel role was not specified, searching for associated channel role`
//         );
//         channel.permissionOverwrites.cache.forEach((overwrite) => {
//           const role = interaction.guild.roles.cache.get(overwrite.id);
//           if (
//             channel.name
//               .toLowerCase()
//               .includes(decamelize(role.name, { separator: '-' }))
//           ) {
//             logger.info(`Associated channel role was found: ${role.name}`);
//             deletableRole = role;
//           }
//         });
//       }
//       if (!deletableRole) {
//         logger.error(`Associated channel role not found, aborting command`);
//         await interaction.reply({
//           ephemeral: true,
//           content: strings.roleNotFound,
//         });
//         return;
//       }
//       await deletableRole.delete();
//       await channel.delete();

//       logger.info(
//         `Channel ${channel.name} and associated channel role ${deletableRole.name} is deleted`
//       );
//       await interaction.reply({
//         ephemeral: true,
//         content: strings.success,
//       });
//     });
//   }
// }

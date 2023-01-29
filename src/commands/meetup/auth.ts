// import // ApplicationCommandOptionType,
// // CommandInteraction,
// // User,
// 'discord.js';
// import { Discord, Slash } from 'discordx';

// // const strings = {
// //   commandDescription: 'User to onboard',
// // };

// @Discord()
// export class AuthUserCommands {
//   @Slash({
//     name: 'auth_meetup',
//     description: 'Authenticate with Meetup. Required for Meetup bot commands',
//   })
//   async authUserHandler() {}
// }
https://secure.meetup.com/oauth2/authorize?client_id={YOUR_CLIENT_KEY}&response_type=code&redirect_uri={YOUR_CLIENT_REDIRECT_URI}
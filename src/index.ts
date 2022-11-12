// import Bree from 'bree';
import { GatewayIntentBits, Interaction, Message } from 'discord.js';
import { Client } from 'discordx';
import express, { Request, Response } from 'express';
import { Logger } from 'tslog';
import Configuration from './configuration';
import './contextMenu';
import './commands';

const logger = new Logger({ name: 'MeetupBot' });

/// ////////////////////////////////////////////////////////////////
//                           CRON JOB                            //
/// ////////////////////////////////////////////////////////////////

// const bree = new Bree({
//   root: 'src',
//   jobs: [
//     // {
//     //   name: 'job that sometimes throws errors',
//     //   path: () => console.log(':)'),
//     //   interval: 'one second',
//     // },
//   ],
//   errorHandler: (error, workerMetadata: Record<string, unknown>) => {
//     logger.error(
//       `There was an error while running a worker ${JSON.stringify(
//         workerMetadata
//       )}`
//     );

//     logger.error(error);
//   },
// });

// bree.start();

/// ////////////////////////////////////////////////////////////////
//                         EXPRESS SERVER                        //
/// ////////////////////////////////////////////////////////////////

const PORT = process.env.PORT || 5000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.use('/', (_request: Request, response: Response) => {
  response.sendStatus(200);
});

/// ////////////////////////////////////////////////////////////////
//                          DISCORD CLIENT                       //
/// ////////////////////////////////////////////////////////////////

const client = new Client({
  simpleCommand: {
    prefix: '!',
  },
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ],
  // If you only want to use global commands only, comment this line
  botGuilds: [(botClient) => botClient.guilds.cache.map((guild) => guild.id)],
});

client.once('ready', async () => {
  // make sure all guilds are in cache
  await client.guilds.fetch();

  // init all application commands
  await client.initApplicationCommands({
    guild: { log: true },
    global: { log: true },
  });

  logger.info('Bot started');
});

client.on('interactionCreate', async (interaction: Interaction) => {
  await client.executeInteraction(interaction);
});

client.on('messageCreate', async (message: Message) => {
  await client.executeCommand(message);
});

async function run() {
  const token = Configuration.discordAPIKey;
  await client.login(token);
}

/// ////////////////////////////////////////////////////////////////
//                             RUN STUFF                         //
/// ////////////////////////////////////////////////////////////////

run().catch((error) => logger.error(JSON.stringify(error)));
app.listen(PORT, () => logger.info(`Server started on port ${PORT}!`));

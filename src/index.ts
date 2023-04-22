import { GatewayIntentBits, Interaction, Message } from 'discord.js';
import { Client } from 'discordx';
import express from 'express';
import session from 'express-session';
import grant from 'grant';
import { Logger } from 'tslog';

import Configuration from './configuration';
import './contextMenu';
import './commands';
import { InMemoryCache } from './lib/cache/memoryCache';

const logger = new Logger({ name: 'MeetupBot' });

/// ////////////////////////////////////////////////////////////////
//                         EXPRESS SERVER                        //
/// ////////////////////////////////////////////////////////////////

const PORT = process.env.PORT || 5000;

const app = express();

app.use(express.urlencoded({ extended: true }));

app
  .use(session({ secret: 'grant', saveUninitialized: true, resave: false }))
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  .use(grant.express(Configuration.grant));

app.get('/persistToken/:maskedUserId', (req, res) => {
  const { maskedUserId } = req.params;
  const accessToken = req.query.access_token.toString();
  InMemoryCache.instance()
    .get(`maskedUserId-${maskedUserId}`)
    .then((userId) =>
      InMemoryCache.instance().set(`userId-${userId}`, accessToken)
    )
    .then(() => res.end(`Connected to Meetup. You can close this window now!`))
    .catch(() => res.end(`Failed to connect to Meetup! Please try again.`));
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
  await client.initApplicationCommands();

  logger.info('Bot started');
});

client.on('interactionCreate', async (interaction: Interaction) => {
  await client.executeInteraction(interaction);
});

client.on('messageCreate', async (message: Message) => {
  await client.executeCommand(message);
});

async function run() {
  const token = Configuration.discord.apiKey;
  await client.login(token);
}

/// ////////////////////////////////////////////////////////////////
//                             RUN STUFF                         //
/// ////////////////////////////////////////////////////////////////

run().catch((error) => logger.error(JSON.stringify(error)));
app.listen(PORT, () => logger.info(`Server started on port ${PORT}!`));

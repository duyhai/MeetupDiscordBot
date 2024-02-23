import {
  GatewayIntentBits,
  Interaction,
  Message,
  OAuth2Scopes,
} from 'discord.js';
import { Client } from 'discordx';
import express from 'express';
import session from 'express-session';
import grant from 'grant';
import { Logger } from 'tslog';

import Configuration from './configuration';
import './buttonMenu';
import './contextMenu';
import './commands';
import { generateOAuthUrl } from './constants';
import { ApplicationCache } from './util/cache';

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

app.get('/persistToken/:name/:maskedUserId', (req, res) => {
  const { maskedUserId, name } = req.params;
  const accessToken = req.query.access_token.toString();
  ApplicationCache()
    .then((cache) => {
      cache
        .get(`maskedUserId-${maskedUserId}`)
        .then((userId) =>
          cache.set(`${userId}-${name}-accessToken`, accessToken)
        )
        .then(() =>
          res.end(`Connected to Meetup. You can close this window now!`)
        )
        .catch(() => res.end(`Failed to connect to Meetup! Please try again.`));
    })
    .catch(() => res.end(`Failed to data store! Please try again.`));
});

app.get('/linked-role', (_req, res) => {
  res.redirect(
    generateOAuthUrl({
      name: 'discord',
      scopes: [OAuth2Scopes.RoleConnectionsWrite],
    })
  );
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

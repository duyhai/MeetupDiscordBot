import { GatewayIntentBits, Interaction, Message } from 'discord.js';
import { Client } from 'discordx';
import express from 'express';
import session from 'express-session';
import grant from 'grant';
import { GraphQLClient, gql } from 'graphql-request';
import { Logger } from 'tslog';

import Configuration from './configuration';
import './contextMenu';
import './commands';

const logger = new Logger({ name: 'MeetupBot' });

/// ////////////////////////////////////////////////////////////////
//                         EXPRESS SERVER                        //
/// ////////////////////////////////////////////////////////////////

const PORT = process.env.PORT || 5000;

const app = express();

app.use(express.urlencoded({ extended: true }));

app
  .use(session({ secret: 'grant', saveUninitialized: true, resave: false }))
  .use(grant.express(Configuration.grant));

// eslint-disable-next-line @typescript-eslint/no-misused-promises
app.get('/persistConnection', async (req, res) => {
  // logger.info(JSON.stringify(req.query, null, 2));
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const client = new GraphQLClient('https://api.meetup.com/gql', {
    headers: {
      authorization: `Bearer ${req.query.access_token.toString()}`,
    },
  });
  const getUserMemberships = gql`
    {
      self {
        id
        name
        memberships {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  `;

  const result: unknown = await client.request(getUserMemberships);
  res.end(JSON.stringify(result, null, 2));
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
  const token = Configuration.discord.apiKey;
  await client.login(token);
}

/// ////////////////////////////////////////////////////////////////
//                             RUN STUFF                         //
/// ////////////////////////////////////////////////////////////////

run().catch((error) => logger.error(JSON.stringify(error)));
app.listen(PORT, () => logger.info(`Server started on port ${PORT}!`));

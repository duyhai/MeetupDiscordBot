import { GatewayIntentBits, Interaction, Message } from 'discord.js';
import { Client } from 'discordx';
import { Logger } from 'tslog';

import './buttonMenu';
import './contextMenu';
import './commands';
import app, { setOAuthAlertClient } from './app.js';
import Configuration from './configuration.js';
import { registerIdentityEvents } from './events/identityEvents.js';
import { startIdentityDigestScheduler } from './lib/helpers/identityDigest.js';
import { startUnlinkedDigestScheduler } from './lib/helpers/unlinkedDigest.js';

const logger = new Logger({ name: 'MeetupBot' });

/// ////////////////////////////////////////////////////////////////
//                         EXPRESS SERVER                         //
/// ////////////////////////////////////////////////////////////////

const PORT = process.env.PORT || 5000;

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

// discord.js >=14.16 types listeners as returning `void` (not Awaitable<void>);
// async handlers are still the standard discordx pattern, so suppress the rule.
// eslint-disable-next-line @typescript-eslint/no-misused-promises
client.once('clientReady', async () => {
  // make sure all guilds are in cache
  await client.guilds.fetch();

  // init all application commands
  await client.initApplicationCommands();

  startUnlinkedDigestScheduler(client);

  // Populate the member cache BEFORE registering identity listeners.
  // userUpdate is guild-agnostic, so its handler resolves members from
  // guild.members.cache -- and GUILD_CREATE only ships ~50 of this guild's
  // 2,008 members. Without this fetch, every global avatar, username and
  // display-name change is silently dropped from each deploy until the daily
  // sweep runs, which can be almost 24h. Events existing to catch transient
  // changes a daily snapshot cannot see is the whole rationale for them.
  for (const guild of client.guilds.cache.values()) {
    try {
      // Sequential: this is a privileged bulk fetch per guild, and the bot is
      // in one guild in practice.
      // eslint-disable-next-line no-await-in-loop
      const members = await guild.members.fetch();
      logger.info(`Cached ${members.size} members for guild ${guild.id}`);
    } catch (error: unknown) {
      // A failed prefetch degrades identity events to sweep-only detection;
      // it must not stop the bot from starting.
      logger.error(
        `Could not prefetch members for guild ${guild.id}: ${String(error)}`,
      );
    }
  }

  registerIdentityEvents(client);
  startIdentityDigestScheduler(client);
  // The express OAuth routes run outside discordCommandWrapper, so without a
  // client their failures reach nobody. Hand it over now that we can post.
  setOAuthAlertClient(client);

  logger.info('Bot started');
});

// eslint-disable-next-line @typescript-eslint/no-misused-promises
client.on('interactionCreate', async (interaction: Interaction) => {
  await client.executeInteraction(interaction);
});

// eslint-disable-next-line @typescript-eslint/no-misused-promises
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

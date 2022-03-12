import { Client } from 'discord.js';
import { Logger } from 'tslog';
import Configuration from './configuration';
import interactionCreate from './listeners/interactionCreate';
import ready from './listeners/ready';

const token = Configuration.discordAPIKey;

const logger = new Logger({ name: 'Bot' });
logger.info('Bot is starting...');

const client = new Client({
  intents: [],
});

ready(client);

interactionCreate(client);

// eslint-disable-next-line @typescript-eslint/no-floating-promises
client.login(token);

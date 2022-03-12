import { Client } from 'discord.js';
import { Logger } from 'tslog';
import Commands from '../Commands';

export default (client: Client): void => {
  client.on('ready', async () => {
    if (!client.user || !client.application) {
      return;
    }

    await client.application.commands.set(Commands);

    const logger = new Logger({ name: 'Client' });
    logger.info(`${client.user.username} is online`);
  });
};

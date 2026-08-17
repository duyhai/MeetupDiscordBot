import { Client, GuildMember, User } from 'discord.js';
import { Logger } from 'tslog';

import { recordIdentityFor } from '../lib/helpers/identityMonitor.js';

const logger = new Logger({ name: 'identityEvents' });

async function safeRecord(member: GuildMember): Promise<void> {
  try {
    await recordIdentityFor(member, 'event');
  } catch (error: unknown) {
    // An unhandled rejection inside a gateway listener takes down the dyno.
    // Missing one change is survivable; the daily sweep re-detects it.
    logger.error(`Identity event handling failed: ${String(error)}`);
  }
}

/**
 * Real-time detection. guildMemberUpdate covers nickname and per-guild
 * avatar; userUpdate covers global username, display name and avatar, which
 * never appear on guildMemberUpdate.
 */
export function registerIdentityEvents(client: Client): void {
  // discord.js types this listener as returning `void`, but the handler is
  // async so tests (and safeRecord's internal error handling) can await it.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  client.on('guildMemberUpdate', (_before, after) => safeRecord(after));

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  client.on('userUpdate', async (_before, after: User) => {
    // userUpdate is guild-agnostic; resolve the member in each guild we share
    // so the per-guild baseline is the thing compared.
    const members = [...client.guilds.cache.values()]
      .map((guild) => guild.members.cache.get(after.id))
      .filter((member): member is GuildMember => Boolean(member));
    await Promise.all(members.map((member) => safeRecord(member)));
  });

  logger.info('Identity change listeners registered');
}

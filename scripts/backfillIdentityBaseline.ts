/**
 * One-time silent population of member_identity.
 *
 * Every member with no baseline is stored without recording a change. Skipping
 * this makes the first digest report all 2,008 members as having changed
 * identity, which is both useless and alarming.
 *
 * Run against production explicitly:
 *   DISCORD_API_KEY=$(heroku config:get DISCORD_API_KEY -a meetup-discord-bot) \
 *   DATABASE_URL=$(heroku config:get DATABASE_URL -a meetup-discord-bot) \
 *   yarn tsx scripts/backfillIdentityBaseline.ts
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { Logger } from 'tslog';

import { runIdentitySweep } from '../src/lib/helpers/identitySweep.js';

const logger = new Logger({ name: 'backfillIdentityBaseline' });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// discord.js >=14.16 types listeners as returning `void` (not Awaitable<void>);
// async handlers are still the standard discordx pattern, so suppress the rule.
// eslint-disable-next-line @typescript-eslint/no-misused-promises
client.once('clientReady', async () => {
  try {
    const result = await runIdentitySweep(client, 'backfill');
    logger.info(
      `Backfill complete: ${result.scanned} scanned, ${result.changed} changes recorded (expected 0 on a fresh table)`,
    );
  } catch (error: unknown) {
    logger.error(`Backfill failed: ${String(error)}`);
  } finally {
    await client.destroy();
  }
});

client.login(process.env.DISCORD_API_KEY).catch((error) => {
  logger.error(`Login failed: ${String(error)}`);
  process.exit(1);
});

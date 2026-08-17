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

// Guards only the wait to reach `clientReady`, not the sweep itself: the
// sweep walks ~2,008 members sequentially and can legitimately take minutes.
// A stalled handshake (DNS blackhole, firewall silently dropping packets,
// TLS hang) makes `client.login()` neither resolve nor reject, so without
// this the script would sit forever with no output on a production dyno
// where nobody is watching it interactively. 60s is generously more than a
// healthy gateway connection ever takes, so it can't false-positive on a
// slow-but-working handshake.
const READY_TIMEOUT_MS = 60_000;
const readyTimeout = setTimeout(() => {
  logger.error(
    `Timed out after ${READY_TIMEOUT_MS}ms waiting for clientReady — connection ` +
      'likely stalled (not a login error, which would have already exited). Exiting.',
  );
  process.exit(1);
}, READY_TIMEOUT_MS);
readyTimeout.unref();

// discord.js >=14.16 types listeners as returning `void` (not Awaitable<void>);
// async handlers are still the standard discordx pattern, so suppress the rule.
// eslint-disable-next-line @typescript-eslint/no-misused-promises
client.once('clientReady', async () => {
  clearTimeout(readyTimeout);
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
  clearTimeout(readyTimeout);
  logger.error(`Login failed: ${String(error)}`);
  process.exit(1);
});

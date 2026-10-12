/**
 * One-time silent population of member_identity.
 *
 * Every member with no baseline is stored without recording a change. Skipping
 * this makes the first digest report all 2,008 members as having changed
 * identity, which is both useless and alarming.
 *
 * Each of those baselines also captures the member's current avatar bytes, so
 * a later change has a real before-image. That is one bounded HTTP request
 * per avatar, sequential: expect this run to take considerably longer than a
 * steady-state sweep.
 *
 * The sweep is run with an UNLIMITED heal budget, not the daily sweep's
 * standard 120s one. After the schema migration the baselines already exist
 * with NULL thumbs, so this script's work routes through the heal path; under
 * the 120s budget one run heals only a few hundred members and then prints
 * "Backfill complete" with most thumbs still missing. Unlimited is safe here
 * because this script is run deliberately, outside the digest's day-claim,
 * and its whole purpose is to finish the thumbnail capture in one run.
 *
 * Run against production explicitly:
 *   DISCORD_API_KEY=$(heroku config:get DISCORD_API_KEY -a meetup-discord-bot) \
 *   DATABASE_URL=$(heroku config:get DATABASE_URL -a meetup-discord-bot) \
 *   yarn tsx scripts/backfillIdentityBaseline.ts
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { Logger } from 'tslog';

import { HealBudget } from '../src/lib/helpers/identity/healBudget.js';
import { runIdentitySweep } from '../src/lib/helpers/identity/sweep.js';

const logger = new Logger({ name: 'backfillIdentityBaseline' });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// Guards only the wait to reach `clientReady`, not the sweep itself: the
// sweep walks ~2,008 members sequentially, fetching a thumbnail for each
// avatar it sees, so it can legitimately run for tens of minutes.
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
    // See the header comment: unlimited, or the run stops healing after 120s.
    const result = await runIdentitySweep(
      client,
      'backfill',
      new HealBudget(Number.POSITIVE_INFINITY),
    );
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

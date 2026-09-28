import { Client } from 'discord.js';
import { Logger } from 'tslog';

import { ChangeSource } from '../repositories/identityTypes.js';
import { recordIdentityFor } from './identityMonitor.js';

const logger = new Logger({ name: 'identitySweep' });

/**
 * Full reconciliation pass. Catches everything the gateway listeners missed
 * while the dyno was restarting, which happens on every deploy and on
 * Heroku's daily cycling.
 *
 * Also performs the initial backfill when called with source 'backfill':
 * members with no baseline are stored silently, so enabling the feature does
 * not report every member in the guild as having changed.
 */
export async function runIdentitySweep(
  client: Client,
  source: ChangeSource,
): Promise<{ scanned: number; changed: number }> {
  const guilds = await client.guilds.fetch();
  const guildId = guilds.first()?.id;
  if (!guildId) {
    return { scanned: 0, changed: 0 };
  }
  const guild = await client.guilds.fetch(guildId);
  const members = await guild.members.fetch();

  let scanned = 0;
  let changed = 0;
  for (const member of members.values()) {
    scanned += 1;
    try {
      // Sequential on purpose: 2,008 concurrent diffs would each want a
      // Postgres connection from a pool of three.
      // eslint-disable-next-line no-await-in-loop
      const changes = await recordIdentityFor(member, source);
      if (changes.length > 0) {
        changed += 1;
      }
    } catch (error: unknown) {
      // One bad member must not abandon the rest of the guild.
      logger.warn(`Sweep failed for ${member.id}: ${String(error)}`);
    }
  }
  logger.info(
    `Identity sweep (${source}): ${scanned} scanned, ${changed} changed`,
  );
  return { scanned, changed };
}

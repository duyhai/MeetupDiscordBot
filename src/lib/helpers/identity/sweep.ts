import { Client } from 'discord.js';
import { Logger } from 'tslog';

import { GUILD_ID } from '../../../constants.js';
import { WritableChangeSource } from '../../repositories/identityTypes.js';
import { HealBudget } from './healBudget.js';
import { recordIdentityFor } from './monitor.js';

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
  source: WritableChangeSource,
): Promise<{ scanned: number; changed: number }> {
  // Resolve the configured guild explicitly. guilds.first() is insertion-
  // ordered, so with a second guild present (test server, staging, a fork)
  // the sweep would diff one guild's members against another's baselines.
  const guild = await client.guilds.fetch(GUILD_ID);
  const members = await guild.members.fetch();

  // One budget for the whole run: baseline-thumb healing stops once it has
  // used HEAL_BUDGET_MS, and whoever is left heals on a later day.
  const healBudget = new HealBudget();

  let scanned = 0;
  let changed = 0;
  for (const member of members.values()) {
    scanned += 1;
    try {
      // Sequential on purpose: 2,008 concurrent diffs would each want a
      // Postgres connection from a pool of three.
      // eslint-disable-next-line no-await-in-loop
      const changes = await recordIdentityFor(member, source, healBudget);
      if (changes.length > 0) {
        changed += 1;
      }
    } catch (error: unknown) {
      // One bad member must not abandon the rest of the guild.
      logger.warn(`Sweep failed for ${member.id}: ${String(error)}`);
    }
  }
  if (healBudget.exhausted) {
    logger.info(
      'Identity sweep: thumbnail-heal budget used up; remaining baselines heal on a later sweep',
    );
  }
  logger.info(
    `Identity sweep (${source}): ${scanned} scanned, ${changed} changed`,
  );
  return { scanned, changed };
}

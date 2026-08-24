/**
 * One-time silent population of the Meetup side of member_identity.
 *
 * Every member with no baseline is stored without recording a change. Skipping
 * this makes the first digest report the entire ~6,000-member roster as having
 * changed identity, which is both useless and alarming.
 *
 * Each of those baselines also captures the member's current photo bytes, so
 * a later photo change has a real before-image -- the only chance to get one,
 * since Meetup's baseline keeps a photo id and not the URL behind it. That is
 * one bounded HTTP request per photo, sequential, across ~6,000 members:
 * expect this run to take considerably longer than a steady-state sweep.
 *
 * Unlike backfillIdentityBaseline.ts, this needs no Discord client or token --
 * only Postgres and the Meetup organizer credential. Run against production
 * explicitly:
 *
 *   DATABASE_URL=$(heroku config:get DATABASE_URL -a meetup-discord-bot) \
 *   MEETUP_KEY=$(heroku config:get MEETUP_KEY -a meetup-discord-bot) \
 *   MEETUP_SECRET=$(heroku config:get MEETUP_SECRET -a meetup-discord-bot) \
 *   MEETUP_ORGANIZER_REFRESH_TOKEN=$(heroku config:get MEETUP_ORGANIZER_REFRESH_TOKEN -a meetup-discord-bot) \
 *   yarn tsx scripts/backfillMeetupIdentity.ts
 *
 * Do NOT run this during hour 18 UTC: the scheduled sweep is doing the same
 * full roster pass at that time, and two passes racing each other can each
 * diff a member before the other advances the baseline, recording the same
 * change twice.
 *
 * Pass --clear-credential to delete the stored organizer credential and exit
 * without sweeping. Needed when the stored refresh token is still VALID but
 * should be replaced by a new grant: resolution prefers the stored pair, so
 * simply setting the config var would change nothing until the stored one
 * happened to fail.
 *
 *   DATABASE_URL=$(heroku config:get DATABASE_URL -a meetup-discord-bot) \
 *   yarn tsx scripts/backfillMeetupIdentity.ts --clear-credential
 */
import { Logger } from 'tslog';

import { runMeetupSweep } from '../src/lib/helpers/identity/meetupSweep.js';
import {
  ApplicationCredentialRepository,
  MEETUP_ORGANIZER_CREDENTIAL_KEY,
} from '../src/util/credentialRepository.js';

const logger = new Logger({ name: 'backfillMeetupIdentity' });

async function clearCredential(): Promise<void> {
  const credentials = await ApplicationCredentialRepository();
  if (!credentials) {
    logger.error(
      'Cannot clear the stored Meetup credential: DATABASE_URL is not set, ' +
        'so there is no credential store to clear.',
    );
    process.exit(1);
  }
  await credentials.clear(MEETUP_ORGANIZER_CREDENTIAL_KEY);
  logger.info(
    'Stored Meetup organizer credential cleared. The next sweep will seed ' +
      'from MEETUP_ORGANIZER_REFRESH_TOKEN -- set that config var to the new ' +
      'refresh token before the next digest.',
  );
}

async function main(): Promise<void> {
  if (process.argv.includes('--clear-credential')) {
    await clearCredential();
    return;
  }

  const result = await runMeetupSweep('backfill');
  logger.info(
    `Meetup backfill complete: ${result.scanned} scanned, ${result.changed} changes recorded (expected 0 on a fresh table)`,
  );

  // Called with no client, runMeetupSweep never alerts on a missing/invalid
  // credential or an unreachable identity repository -- it logs and returns
  // {0, 0}, same shape as a real sweep that legitimately found zero changes.
  // scanned === 0 is the tell: a real pass touches ~6,000 members, so zero
  // scanned means the sweep never ran, not that the group is empty.
  if (result.scanned === 0) {
    logger.error(
      'Backfill scanned no members -- the sweep did not run (missing or ' +
        'invalid Meetup credential, unreachable database, or unreachable ' +
        'Meetup API), not an empty group. Check the warnings above and ' +
        'fix the underlying cause before retrying.',
    );
    process.exit(1);
  }

  if (result.changed > 0) {
    logger.error(
      'Backfill recorded changes on what should be a fresh table -- do not proceed to the digest until this is understood.',
    );
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  logger.error(`Backfill failed: ${String(error)}`);
  process.exit(1);
});

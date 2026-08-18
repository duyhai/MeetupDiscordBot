/**
 * One-time silent population of the Meetup side of member_identity.
 *
 * Every member with no baseline is stored without recording a change. Skipping
 * this makes the first digest report the entire ~6,000-member roster as having
 * changed identity, which is both useless and alarming.
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
 */
import { Logger } from 'tslog';

import { runMeetupSweep } from '../src/lib/helpers/identity/meetupSweep.js';

const logger = new Logger({ name: 'backfillMeetupIdentity' });

async function main(): Promise<void> {
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

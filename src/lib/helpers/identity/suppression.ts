/**
 * Short-lived record of members the bot is currently writing to itself.
 *
 * Onboarding sets a member's nickname and then advances the identity baseline
 * so the bot's own write is not reported as a suspicious name change. That
 * alone is a race, not a fix: Discord dispatches GUILD_MEMBER_UPDATE
 * concurrently with the HTTP response to setNickname, so the gateway handler's
 * getSnapshot can read the OLD baseline before updateBaselineSilently commits
 * the new one -- and the bot's own rename lands in the organizers' digest.
 * Onboarding happens several times a day, so that noise is not theoretical.
 *
 * Suppression rather than repair: the event path skips recording while a
 * member is in this set, but still advances the baseline, so nothing drifts.
 *
 * Deliberately timestamp-based rather than timer-based: no setTimeout to leak,
 * unref, or leave dangling in tests, and expiry is decided at read time.
 *
 * This module owns no imports on purpose -- both identityMonitor and
 * onboardUser reach it without either importing the other.
 */

/**
 * Safety net. If onboarding throws between setNickname and its release, the
 * entry must not suppress that member's real changes forever.
 */
const HARD_TTL_MS = 30_000;

/**
 * How long to keep suppressing after the bot's write is fully committed.
 * Covers gateway dispatch arriving after the REST response -- a few seconds
 * is generous; the cost of overshooting is one missed change that the daily
 * sweep re-detects anyway.
 */
const RELEASE_DELAY_MS = 5_000;

const suppressedUntil = new Map<string, number>();

function dropExpired(now: number): void {
  for (const [userId, until] of suppressedUntil) {
    if (now >= until) {
      suppressedUntil.delete(userId);
    }
  }
}

/** Call immediately BEFORE the bot writes this member's identity. */
export function suppressIdentityWrites(userId: string): void {
  const now = Date.now();
  dropExpired(now);
  suppressedUntil.set(userId, now + HARD_TTL_MS);
}

export function isIdentityWriteSuppressed(userId: string): boolean {
  const until = suppressedUntil.get(userId);
  if (until === undefined) {
    return false;
  }
  if (Date.now() >= until) {
    suppressedUntil.delete(userId);
    return false;
  }
  return true;
}

/**
 * Call AFTER the baseline has been advanced. Does not clear immediately: the
 * gateway event that the bot's own write triggered may still be in flight.
 */
export function releaseIdentityWriteSuppression(userId: string): void {
  const until = suppressedUntil.get(userId);
  if (until === undefined) {
    return;
  }
  // Never extend past the hard TTL -- release only ever shortens.
  suppressedUntil.set(userId, Math.min(until, Date.now() + RELEASE_DELAY_MS));
}

/** Test seam. Never called in production. */
export function clearIdentityWriteSuppression(): void {
  suppressedUntil.clear();
}

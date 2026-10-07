import { Logger } from 'tslog';

import { boundedFetch } from '../../../util/boundedFetch.js';
import {
  ChangeThumbMap,
  IdentityBaselineThumbs,
  IdentityChange,
  IdentitySnapshot,
  StoredIdentitySnapshot,
} from '../../repositories/identityTypes.js';
import { avatarThumbUrl } from './snapshot.js';

const logger = new Logger({ name: 'identityThumbs' });

/**
 * The two avatar fields, mapped to the baseline column that holds each one's
 * stored image. Anything not listed here (nickname, username, global name)
 * has no picture and is skipped entirely.
 */
const AVATAR_THUMB_COLUMN = {
  user_avatar: 'userAvatarThumb',
  member_avatar: 'memberAvatarThumb',
} as const;

type AvatarField = keyof typeof AVATAR_THUMB_COLUMN;

function isAvatarField(field: string): field is AvatarField {
  return field in AVATAR_THUMB_COLUMN;
}

const THUMB_FETCH_TIMEOUT_MS = 5_000;

async function fetchOne(url: string): Promise<Buffer | null> {
  try {
    // Undici applies no total-request deadline, and this runs inside the
    // digest after the day-claim is taken: a stalled connection would hang
    // the digest with no error and no retry. The existing catch turns a
    // timeout into the documented best-effort null thumb.
    const response = await boundedFetch(url, undefined, THUMB_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error: unknown) {
    logger.warn(`Thumbnail fetch failed for ${url}: ${String(error)}`);
    return null;
  }
}

/**
 * Before/after images for a member's avatar changes, plus the thumbs the
 * advanced baseline should carry.
 *
 * The OLD side is never fetched. Discord purges a superseded avatar sometime
 * after it is replaced, so by the time a sweep notices the hash changed the
 * old URL may already 404 -- and this is precisely the image an organizer
 * needs. It is read out of the baseline row instead, which is the reason the
 * baseline stores thumbs at all. Only the new image costs a request, once.
 *
 * Best-effort by design: a failed fetch yields null so the change is still
 * recorded.
 */
export async function resolveChangeThumbs(
  changes: IdentityChange[],
  guildId: string,
  baseline: StoredIdentitySnapshot,
): Promise<{ thumbs: ChangeThumbMap; baselineThumbs: IdentityBaselineThumbs }> {
  const thumbs: ChangeThumbMap = new Map();
  const baselineThumbs: IdentityBaselineThumbs = {};
  for (const change of changes) {
    if (!isAvatarField(change.field)) {
      continue;
    }
    const field = change.field;
    /* eslint-disable no-await-in-loop */
    // Sequential: a member changing both avatars at once is two requests, not
    // a fan-out, and the sweep already runs one member at a time.
    const newThumb = change.newValue
      ? await fetchOne(
          avatarThumbUrl(change.subjectId, field, change.newValue, guildId),
        )
      : null;
    /* eslint-enable no-await-in-loop */
    // recordChanges reads back with the same four-part key: platform and
    // scopeId scope the identity, subjectId and field pick the row within it.
    thumbs.set(
      `${change.platform}:${change.scopeId}:${change.subjectId}:${change.field}`,
      { oldThumb: baseline[AVATAR_THUMB_COLUMN[field]], newThumb },
    );
    // Set unconditionally, including when the fetch failed: the baseline's
    // thumb describes the hash stored beside it, so keeping the superseded
    // image under the new hash would make tomorrow's before-image a lie.
    baselineThumbs[AVATAR_THUMB_COLUMN[field]] = newThumb;
  }
  return { thumbs, baselineThumbs };
}

/**
 * The member's current avatar images, for a first sighting.
 *
 * A first sighting records no change -- it IS the baseline -- but it is the
 * only chance to capture these bytes while their URLs still resolve. Without
 * this the member's first real avatar change would have no before-image, the
 * exact gap the baseline thumbs exist to close.
 *
 * Sequential, and skipped outright for a member with no avatar, which keeps
 * the backfill's request count to what it actually needs.
 */
export async function fetchBaselineThumbs(
  snapshot: IdentitySnapshot,
  guildId: string,
): Promise<IdentityBaselineThumbs> {
  const userAvatarThumb = snapshot.userAvatarHash
    ? await fetchOne(
        avatarThumbUrl(
          snapshot.discordUserId,
          'user_avatar',
          snapshot.userAvatarHash,
          guildId,
        ),
      )
    : null;
  const memberAvatarThumb = snapshot.memberAvatarHash
    ? await fetchOne(
        avatarThumbUrl(
          snapshot.discordUserId,
          'member_avatar',
          snapshot.memberAvatarHash,
          guildId,
        ),
      )
    : null;
  return { userAvatarThumb, memberAvatarThumb };
}

/**
 * True when the baseline names an avatar it holds no image for: a hash is
 * stored but its thumb column is empty. Happens for every baseline that
 * predates the thumb columns (the migrated production rows), for baselines
 * created by onboarding's updateBaselineSilently, and for any first-sighting
 * fetch that failed. A null hash means "no avatar", which needs no image.
 */
export function needsThumbHeal(baseline: StoredIdentitySnapshot): boolean {
  return (
    (baseline.userAvatarHash !== null && baseline.userAvatarThumb === null) ||
    (baseline.memberAvatarHash !== null && baseline.memberAvatarThumb === null)
  );
}

/**
 * Fetches the images missing from an unchanged baseline -- only those whose
 * hash is set and whose thumb is empty -- and returns just the ones that
 * arrived. A failed fetch is left OUT rather than set to null, so the heal
 * writes nothing for it and the next sweep simply tries again.
 *
 * Valid only when the baseline's hashes are still current (the caller has
 * found no change): the URL is built from the stored hash, and the image is
 * filed under that same hash.
 */
export async function fetchMissingBaselineThumbs(
  baseline: StoredIdentitySnapshot,
  guildId: string,
): Promise<IdentityBaselineThumbs> {
  const healed: IdentityBaselineThumbs = {};
  if (baseline.userAvatarHash !== null && baseline.userAvatarThumb === null) {
    const thumb = await fetchOne(
      avatarThumbUrl(
        baseline.discordUserId,
        'user_avatar',
        baseline.userAvatarHash,
        guildId,
      ),
    );
    if (thumb) {
      healed.userAvatarThumb = thumb;
    }
  }
  if (
    baseline.memberAvatarHash !== null &&
    baseline.memberAvatarThumb === null
  ) {
    const thumb = await fetchOne(
      avatarThumbUrl(
        baseline.discordUserId,
        'member_avatar',
        baseline.memberAvatarHash,
        guildId,
      ),
    );
    if (thumb) {
      healed.memberAvatarThumb = thumb;
    }
  }
  return healed;
}

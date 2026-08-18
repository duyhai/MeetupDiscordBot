import { Logger } from 'tslog';

import { boundedFetch } from '../../../util/boundedFetch.js';
import { IdentityChange } from '../../repositories/identityTypes.js';
import { avatarThumbUrl } from './snapshot.js';

const logger = new Logger({ name: 'identityThumbs' });

const AVATAR_FIELDS = new Set(['user_avatar', 'member_avatar']);

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
 * Retrieves before/after thumbnails for avatar changes. Best-effort by
 * design: a failed fetch yields null so the change is still recorded.
 */
export async function fetchChangeThumbs(
  changes: IdentityChange[],
  guildId: string,
): Promise<Map<string, { oldThumb: Buffer | null; newThumb: Buffer | null }>> {
  const thumbs = new Map<
    string,
    { oldThumb: Buffer | null; newThumb: Buffer | null }
  >();
  for (const change of changes) {
    if (!AVATAR_FIELDS.has(change.field)) {
      continue;
    }
    const field = change.field as 'user_avatar' | 'member_avatar';
    /* eslint-disable no-await-in-loop */
    const oldThumb = change.oldValue
      ? await fetchOne(
          avatarThumbUrl(change.subjectId, field, change.oldValue, guildId),
        )
      : null;
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
      { oldThumb, newThumb },
    );
  }
  return thumbs;
}

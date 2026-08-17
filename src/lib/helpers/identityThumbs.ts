import { Logger } from 'tslog';

import { IdentityChange } from '../repositories/identityTypes.js';
import { avatarThumbUrl } from './identitySnapshot.js';

const logger = new Logger({ name: 'identityThumbs' });

const AVATAR_FIELDS = new Set(['user_avatar', 'member_avatar']);

async function fetchOne(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url);
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
          avatarThumbUrl(change.discordUserId, field, change.oldValue, guildId),
        )
      : null;
    const newThumb = change.newValue
      ? await fetchOne(
          avatarThumbUrl(change.discordUserId, field, change.newValue, guildId),
        )
      : null;
    /* eslint-enable no-await-in-loop */
    thumbs.set(`${change.discordUserId}:${change.field}`, {
      oldThumb,
      newThumb,
    });
  }
  return thumbs;
}

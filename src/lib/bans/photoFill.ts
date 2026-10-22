import { Client } from 'discord.js';
import { Logger } from 'tslog';

import { GUILD_ID } from '../../constants.js';
import { fetchBytesCapped } from '../../util/boundedFetch.js';
import { ApplicationIdentityRepository } from '../../util/identityRepository.js';
import { MeetupGroupMember } from '../client/meetup/types.js';
import { HealBudget } from '../helpers/identity/healBudget.js';
import { avatarThumbUrl } from '../helpers/identity/snapshot.js';
import { sniffImageType, stripImageMetadata } from '../helpers/imageBytes.js';
import { PostgresBanRepository } from '../repositories/postgresBanRepository.js';
import { PostgresMemberRepository } from '../repositories/postgresMemberRepository.js';
import { BAN_FILL_MAX_PER_RUN, BAN_PHOTO_MAX_BYTES } from './types.js';

const logger = new Logger({ name: 'banPhotoFill' });

/** The whole fill, after the daily sweeps. */
export const BAN_FILL_DEADLINE_MS = 90_000;
/** Time spent finding photos (downloads and the stored-photo read). */
export const BAN_FILL_BUDGET_MS = 60_000;
/** One download. */
export const BAN_FILL_FETCH_TIMEOUT_MS = 5_000;

export interface BanPhotoFillDeps {
  bans(): Promise<
    Pick<PostgresBanRepository, 'listPhotoFillCandidates' | 'fillProfilePhoto'>
  >;
  discordIdsByMeetupIds(ids: string[]): Promise<Map<string, string>>;
  guildMember(
    discordId: string,
  ):
    | { userAvatarHash: string | null; memberAvatarHash: string | null }
    | undefined;
  storedPhoto(
    meetupId: string,
    discordId: string | undefined,
  ): Promise<Buffer | undefined>;
  fetchBytes(url: string): Promise<Buffer | null>;
  guildId: string;
  now(): number;
}

export interface BanPhotoFillCounts {
  candidates: number;
  filled: number;
  fromDiscord: number;
  fromMeetup: number;
  fromStored: number;
  noSource: number;
  /** Candidates whose lookup or write threw (caught; the run went on). */
  failed: number;
}

type FillSource = 'discord' | 'meetup' | 'stored';

const DISCORD_CDN = 'cdn.discordapp.com';
const MEETUP_PHOTO_DOMAIN = 'meetupstatic.com';

/** https on the Discord CDN or a Meetup photo host, and nothing else. */
export function isBanPhotoSourceUrl(url: unknown): url is string {
  if (typeof url !== 'string') {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  return (
    parsed.protocol === 'https:' &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    (host === DISCORD_CDN ||
      host === MEETUP_PHOTO_DOMAIN ||
      host.endsWith(`.${MEETUP_PHOTO_DOMAIN}`))
  );
}

/**
 * The bytes to store, or undefined: stripped of metadata first (D14; PNG
 * sources too), then a known image type within the cap.
 */
function acceptable(bytes: Buffer | null | undefined): Buffer | undefined {
  if (!bytes || bytes.length === 0) {
    return undefined;
  }
  const stripped = stripImageMetadata(bytes);
  if (
    stripped === undefined ||
    sniffImageType(stripped) === undefined ||
    stripped.length > BAN_PHOTO_MAX_BYTES
  ) {
    return undefined;
  }
  return stripped;
}

/** The first usable photo from the D12 sources, in order. */
async function findPhoto(
  deps: BanPhotoFillDeps,
  meetupId: string,
  discordId: string | undefined,
  rosterMember: MeetupGroupMember | undefined,
): Promise<{ photo: Buffer; source: FillSource } | undefined> {
  const fetchFrom = async (urls: (string | null | undefined)[]) => {
    for (const url of urls) {
      if (isBanPhotoSourceUrl(url)) {
        // One source at a time, first acceptable wins. A failed download
        // is the same as no photo there: try the next source.
        let bytes: Buffer | null = null;
        try {
          // eslint-disable-next-line no-await-in-loop
          bytes = await deps.fetchBytes(url);
        } catch {
          bytes = null;
        }
        const photo = acceptable(bytes);
        if (photo) {
          return photo;
        }
      }
    }
    return undefined;
  };

  // 1. Discord: only a linked member still in the guild's member cache.
  const member = discordId ? deps.guildMember(discordId) : undefined;
  if (discordId && member) {
    const urls = [
      member.memberAvatarHash
        ? avatarThumbUrl(
            discordId,
            'member_avatar',
            member.memberAvatarHash,
            deps.guildId,
            256,
          )
        : undefined,
      member.userAvatarHash
        ? avatarThumbUrl(
            discordId,
            'user_avatar',
            member.userAvatarHash,
            deps.guildId,
            256,
          )
        : undefined,
    ];
    const photo = await fetchFrom(urls);
    if (photo) {
      return { photo, source: 'discord' };
    }
  }

  // 2. Meetup: the roster's standard photo, then its thumb. Never highResUrl.
  const meetupPhoto = rosterMember?.memberPhoto;
  if (meetupPhoto) {
    const photo = await fetchFrom([
      meetupPhoto.standardUrl,
      meetupPhoto.thumbUrl,
    ]);
    if (photo) {
      return { photo, source: 'meetup' };
    }
  }

  // 3. The newest image the identity monitor stored.
  const stored = acceptable(await deps.storedPhoto(meetupId, discordId));
  return stored ? { photo: stored, source: 'stored' } : undefined;
}

/**
 * Fills a photo into active bans that have none, from the member's profile.
 * Sequential; at most BAN_FILL_MAX_PER_RUN bans; stops when the budget is
 * spent (the rest wait for tomorrow). `fillProfilePhoto` writes only
 * `WHERE photo IS NULL AND lifted_at IS NULL`, so it never replaces a photo.
 */
export async function fillBanPhotos(
  deps: BanPhotoFillDeps,
  roster: readonly MeetupGroupMember[] | undefined,
  budget: HealBudget = new HealBudget(BAN_FILL_BUDGET_MS, () => deps.now()),
): Promise<BanPhotoFillCounts> {
  const counts: BanPhotoFillCounts = {
    candidates: 0,
    filled: 0,
    fromDiscord: 0,
    fromMeetup: 0,
    fromStored: 0,
    noSource: 0,
    failed: 0,
  };
  const bans = await deps.bans();
  const candidates = (
    await bans.listPhotoFillCandidates(BAN_FILL_MAX_PER_RUN)
  ).slice(0, BAN_FILL_MAX_PER_RUN);
  counts.candidates = candidates.length;
  if (candidates.length === 0) {
    return counts;
  }

  const wanted = new Set(candidates.map((c) => c.memberId));
  // Only the candidates' entries: at most 50, never a copy of the roster.
  const rosterById = new Map<string, MeetupGroupMember>();
  for (const member of roster ?? []) {
    if (wanted.has(member.id)) {
      rosterById.set(member.id, member);
    }
  }
  let links = new Map<string, string>();
  try {
    links = await deps.discordIdsByMeetupIds([...wanted]);
  } catch (error: unknown) {
    // Discord is one source of three; the others still run.
    logger.warn(
      `Ban photo fill link lookup failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
  }

  for (const candidate of candidates) {
    if (budget.exhausted) {
      break;
    }
    try {
      // Sequential on purpose: one download at a time, inside the budget.
      // eslint-disable-next-line no-await-in-loop
      const found = await budget.spend(() =>
        findPhoto(
          deps,
          candidate.memberId,
          links.get(candidate.memberId),
          rosterById.get(candidate.memberId),
        ),
      );
      if (!found) {
        counts.noSource += 1;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      if (await bans.fillProfilePhoto(candidate.id, found.photo)) {
        counts.filled += 1;
        if (found.source === 'discord') counts.fromDiscord += 1;
        else if (found.source === 'meetup') counts.fromMeetup += 1;
        else counts.fromStored += 1;
      }
      // false: a staff upload (or a lift) landed first. Nothing else to do.
    } catch (error: unknown) {
      counts.failed += 1;
      logger.warn(
        `Ban photo fill failed for one ban: ${error instanceof Error ? error.name : 'Error'}`,
      );
    }
  }
  return counts;
}

/** A budget the deadline can close, so a late run stops at its next ban. */
class DeadlineBudget extends HealBudget {
  closed = false;

  override get exhausted(): boolean {
    return this.closed || super.exhausted;
  }
}

/** fillBanPhotos under BAN_FILL_DEADLINE_MS; never rejects; logs counts only. */
export async function runBanPhotoFillSafely(
  deps: BanPhotoFillDeps,
  roster: readonly MeetupGroupMember[] | undefined,
): Promise<void> {
  const budget = new DeadlineBudget(BAN_FILL_BUDGET_MS, () => deps.now());
  let timer: NodeJS.Timeout | undefined;
  try {
    // Subscribed by the race, so a fill that fails after the deadline is
    // still handled (never an unhandled rejection).
    const fill = fillBanPhotos(deps, roster, budget);
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), BAN_FILL_DEADLINE_MS);
      timer.unref();
    });
    const outcome = await Promise.race([fill, deadline]);
    if (outcome === 'deadline') {
      budget.closed = true;
      fill.catch(() => undefined);
      logger.warn('Ban photo fill stopped at its deadline');
      return;
    }
    const c = outcome;
    logger.info(
      `Ban photo fill: ${c.filled} of ${c.candidates} filled ` +
        `(${c.fromDiscord} Discord, ${c.fromMeetup} Meetup, ${c.fromStored} stored), ` +
        `${c.noSource} without a usable photo` +
        (c.failed > 0 ? `, ${c.failed} failed` : ''),
    );
  } catch (error: unknown) {
    logger.warn(
      `Ban photo fill failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Production wiring: no API call for the guild; capped downloads only. */
export function defaultBanPhotoFillDeps(client: Client): BanPhotoFillDeps {
  return {
    bans: () => PostgresBanRepository.instance(),
    discordIdsByMeetupIds: async (ids) =>
      (await PostgresMemberRepository.instance()).discordIdsByMeetupIds(ids),
    guildMember: (discordId) => {
      const member = client.guilds?.cache
        .get(GUILD_ID)
        ?.members.cache.get(discordId);
      return member
        ? {
            userAvatarHash: member.user.avatar ?? null,
            memberAvatarHash: member.avatar ?? null,
          }
        : undefined;
    },
    storedPhoto: async (meetupId, discordId) => {
      const repo = await ApplicationIdentityRepository();
      return repo?.latestStoredPhoto(meetupId, discordId, BAN_PHOTO_MAX_BYTES);
    },
    fetchBytes: async (url) => {
      if (!isBanPhotoSourceUrl(url)) {
        return null;
      }
      return fetchBytesCapped(
        url,
        BAN_PHOTO_MAX_BYTES,
        BAN_FILL_FETCH_TIMEOUT_MS,
      );
    },
    guildId: GUILD_ID,
    now: () => Date.now(),
  };
}

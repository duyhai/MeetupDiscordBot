import { Client } from 'discord.js';
import { Logger } from 'tslog';

import { GUILD_ID } from '../../constants.js';
import { fetchBytesCappedOutcome } from '../../util/boundedFetch.js';
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
  /**
   * The body, `'too-large'` when it is over BAN_PHOTO_MAX_BYTES, or null
   * when the download failed (timeout, non-2xx, error).
   */
  fetchBytes(url: string): Promise<Buffer | 'too-large' | null>;
  guildId: string;
  now(): number;
}

export interface BanPhotoFillCounts {
  candidates: number;
  filled: number;
  fromDiscord: number;
  fromMeetup: number;
  fromStored: number;
  /** Nothing usable anywhere: every live source over the cap, or none. */
  noSource: number;
  /**
   * Left for tomorrow: a live source's download failed, or a live source
   * could not be checked (roster not fetched, link lookup failed). Never
   * filled from the stored thumbnail, so one bad day cannot lock in a
   * postage-stamp photo.
   */
  deferred: number;
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
 * The bytes to store, `'too-large'` when they are over the cap after the
 * strip, or undefined when they are not a usable image: stripped of metadata
 * first (D14; PNG sources too), then a known image type within the cap.
 */
function acceptable(
  bytes: Buffer | 'too-large' | null | undefined,
): Buffer | 'too-large' | undefined {
  if (bytes === 'too-large') {
    return 'too-large';
  }
  if (!bytes || bytes.length === 0) {
    return undefined;
  }
  const stripped = stripImageMetadata(bytes);
  if (stripped === undefined || sniffImageType(stripped) === undefined) {
    return undefined;
  }
  return stripped.length > BAN_PHOTO_MAX_BYTES ? 'too-large' : stripped;
}

type Found = { photo: Buffer; source: FillSource } | 'deferred' | undefined;

/**
 * The first usable photo from the D12 sources, in order, or 'deferred'.
 *
 * Inside a live source (Discord avatars, then Meetup standard then thumb),
 * only a file over the cap moves on to the next, smaller one. Any other
 * failure defers the ban to tomorrow, so a timeout cannot lock in a smaller
 * photo (the fill never overwrites). The stored identity thumbnail is used
 * only for a member known to be gone from both live sources.
 */
async function findPhoto(
  deps: BanPhotoFillDeps,
  meetupId: string,
  discordId: string | undefined,
  rosterMember: MeetupGroupMember | undefined,
  known: { links: boolean; roster: boolean; discord: boolean },
): Promise<Found> {
  const fetchFrom = async (
    urls: (string | null | undefined)[],
  ): Promise<Buffer | 'deferred' | undefined> => {
    for (const url of urls) {
      if (isBanPhotoSourceUrl(url)) {
        // One source at a time, first acceptable wins.
        let bytes: Buffer | 'too-large' | null = null;
        try {
          // eslint-disable-next-line no-await-in-loop
          bytes = await deps.fetchBytes(url);
        } catch {
          bytes = null;
        }
        const photo = acceptable(bytes);
        if (photo === undefined) {
          return 'deferred';
        }
        if (photo !== 'too-large') {
          return photo;
        }
        // Over the cap: the next, smaller size may do.
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
    if (photo === 'deferred') {
      return 'deferred';
    }
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
    if (photo === 'deferred') {
      return 'deferred';
    }
    if (photo) {
      return { photo, source: 'meetup' };
    }
  }

  // 3. The newest image the identity monitor stored, only when every live
  // source is known to have no photo at all: the member is gone from it, or
  // still there with none (Hai, 2026-10-22). A source with a photo that did
  // not do (every size over the cap, or no allowed URL): no source. A source
  // that could not be checked (roster or links unread today, or a linked
  // member in a guild cache the Discord sweep could not refresh): tomorrow.
  const discord = discordSource(member, discordId, known);
  const meetup = meetupSource(rosterMember, known);
  if (discord === 'has-photo' || meetup === 'has-photo') {
    return undefined;
  }
  if (discord === 'unknown' || meetup === 'unknown') {
    return 'deferred';
  }
  const stored = acceptable(await deps.storedPhoto(meetupId, discordId));
  return stored && stored !== 'too-large'
    ? { photo: stored, source: 'stored' }
    : undefined;
}

/** What one live source says about the member's photo, for the stored fallback. */
type LiveSource = 'has-photo' | 'no-photo' | 'unknown';

/**
 * Discord: no photo when the link lookup worked and the member is unlinked,
 * or is linked and, in a guild cache today's sweep refreshed, either absent
 * or present with neither avatar. A partial cache is never trusted.
 */
function discordSource(
  member: ReturnType<BanPhotoFillDeps['guildMember']>,
  discordId: string | undefined,
  known: { links: boolean; discord: boolean },
): LiveSource {
  if (member && (member.memberAvatarHash || member.userAvatarHash)) {
    return 'has-photo';
  }
  if (!known.links) {
    return 'unknown';
  }
  if (!discordId) {
    return 'no-photo';
  }
  return known.discord ? 'no-photo' : 'unknown';
}

/** Meetup: no photo when the roster was fetched and the member is absent or has no photo URL. */
function meetupSource(
  rosterMember: MeetupGroupMember | undefined,
  known: { roster: boolean },
): LiveSource {
  const photo = rosterMember?.memberPhoto;
  if (photo && (photo.standardUrl || photo.thumbUrl)) {
    return 'has-photo';
  }
  return known.roster ? 'no-photo' : 'unknown';
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
  /** False when today's Discord sweep failed: the guild cache may be partial. */
  discordKnown: boolean,
  budget: HealBudget = new HealBudget(BAN_FILL_BUDGET_MS, () => deps.now()),
): Promise<BanPhotoFillCounts> {
  const counts: BanPhotoFillCounts = {
    candidates: 0,
    filled: 0,
    fromDiscord: 0,
    fromMeetup: 0,
    fromStored: 0,
    noSource: 0,
    deferred: 0,
    failed: 0,
  };
  const bans = await deps.bans();
  const candidates = (
    await bans.listPhotoFillCandidates(
      BAN_FILL_MAX_PER_RUN,
      new Date(deps.now()).toISOString().slice(0, 10),
    )
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
  let linksKnown = false;
  try {
    links = await deps.discordIdsByMeetupIds([...wanted]);
    linksKnown = true;
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
          {
            links: linksKnown,
            roster: roster !== undefined,
            discord: discordKnown,
          },
        ),
      );
      if (found === 'deferred') {
        counts.deferred += 1;
        continue;
      }
      if (!found) {
        counts.noSource += 1;
        continue;
      }
      if (
        // eslint-disable-next-line no-await-in-loop
        await bans.fillProfilePhoto(
          candidate.id,
          found.photo,
          found.source === 'stored' ? 'identity-thumb' : 'profile',
        )
      ) {
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
  discordKnown: boolean,
): Promise<void> {
  const budget = new DeadlineBudget(BAN_FILL_BUDGET_MS, () => deps.now());
  let timer: NodeJS.Timeout | undefined;
  try {
    // Subscribed by the race, so a fill that fails after the deadline is
    // still handled (never an unhandled rejection).
    const fill = fillBanPhotos(deps, roster, discordKnown, budget);
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
        (c.deferred > 0 ? `, ${c.deferred} deferred to tomorrow` : '') +
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
      return fetchBytesCappedOutcome(
        url,
        BAN_PHOTO_MAX_BYTES,
        BAN_FILL_FETCH_TIMEOUT_MS,
      );
    },
    guildId: GUILD_ID,
    now: () => Date.now(),
  };
}

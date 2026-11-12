/**
 * The /wrapped command and its Share button, as functions over an
 * interaction and injectable dependencies (so the whole flow is unit-tested
 * without Discord or Meetup). Both run inside discordCommandWrapper: the
 * progress reply already exists, so they editReply for progress and
 * followUp (ephemeral) for the answer.
 */
import {
  ButtonInteraction,
  Channel,
  Client,
  CommandInteraction,
  GuildMember,
  GuildTextBasedChannel,
  PermissionFlagsBits,
} from 'discord.js';
import { Logger } from 'tslog';

import Configuration from '../../configuration.js';
import { KeyValueCache } from '../cache/base.js';
import { LogEntry, logAlert } from '../helpers/discordLogger.js';
import {
  PostgresWrappedBackfillRepository,
  WrappedBackfillStore,
} from '../repositories/postgresWrappedBackfillRepository.js';
import {
  PostgresWrappedEntryRepository,
  WrappedEntryStore,
} from '../repositories/postgresWrappedEntryRepository.js';
import { MemberRepository } from '../repositories/types.js';
import { describeBuildError } from '../reports/buildJob.js';
import { withOrganizerMeetup } from '../reports/organizerMeetup.js';
import { ApplicationCache } from '../../util/cache.js';
import { keepReplyVisible } from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';
import { FixedWindowLimiter } from '../../web/rateLimit.js';
import { PostgresSnapshotRepository } from '../repositories/postgresSnapshotRepository.js';
import {
  SnapshotWrapped,
  buildWrappedFromSnapshot,
  snapshotWrapped,
  storedTokenSelfCount,
} from '../snapshot/wrapped.js';
import { BuildDeps, BuildResult, buildWrapped } from './build.js';
import {
  BUILDING_LEASE_TTL_SEC,
  CachedWrapped,
  SHARE_GUARD_TTL_SEC,
  buildingKey,
  shareGuardKey,
  wrappedBuildLimiter,
} from './cache.js';
import { WrappedTiers, readEntry, writeEntry } from './store.js';
import {
  parseShareCustomId,
  replies,
  shareButtonRow,
  sharedPostContent,
  wrappedEmbed,
} from './format.js';
import { discordClock, queueForLater, queuedText } from './queue.js';

const logger = new Logger({ name: 'wrapped' });

/** Past this, the member is told to expect a DM instead of waiting. */
export const SLOW_BUILD_MS = 10_000;

export interface WrappedHandlerDeps {
  /** Plain alert to #meetup-bot-alerts (never a Meetup response body). */
  alert(client: Client, entry: LogEntry): Promise<boolean>;
  cache(): Promise<KeyValueCache>;
  members(): Promise<MemberRepository>;
  withMeetupClient: typeof withMeetupClient;
  withOrganizerMeetup: typeof withOrganizerMeetup;
  limiter: FixedWindowLimiter;
  now(): Date;
  slowAfterMs: number;
  /**
   * The backfill queue: a throttled request with nothing cached is queued
   * for the next tick. Left out, or rejecting (no DATABASE_URL), the reply
   * is the plain limit.
   */
  queue?(): Promise<WrappedBackfillStore>;
  /** The durable Wrapped store; left out or rejecting, Redis alone. */
  entries?(): Promise<WrappedEntryStore>;
  /**
   * The group snapshot: a member it can serve is built from it with no
   * Meetup token (no OAuth hop). Left out or rejecting, the token path.
   */
  snapshot?(): Promise<SnapshotWrapped>;
  /** The member's stored token's past-RSVP count, the snapshot's cross-check. */
  selfPastCount?(discordUserId: string): Promise<number | undefined>;
}

/** The snapshot's sources for the member, or undefined for the token path. Never throws. */
async function snapshotSources(
  deps: WrappedHandlerDeps,
  discordUserId: string,
  linkedMeetupId: string,
) {
  if (!deps.snapshot) {
    return undefined;
  }
  try {
    const snapshot = await deps.snapshot();
    const sources = await snapshot.sources(
      linkedMeetupId,
      deps.selfPastCount
        ? () =>
            deps.selfPastCount?.(discordUserId) ?? Promise.resolve(undefined)
        : undefined,
    );
    return sources ? { snapshot, sources } : undefined;
  } catch (error) {
    logger.warn(
      `Wrapped snapshot unavailable, using the token path: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return undefined;
  }
}

/** Both tiers; a Postgres that cannot be reached leaves the Redis tier alone. */
async function tiersFor(deps: WrappedHandlerDeps): Promise<WrappedTiers> {
  const cache = await deps.cache();
  if (!deps.entries) {
    return { cache };
  }
  try {
    return { cache, entries: await deps.entries() };
  } catch (error) {
    logger.warn(
      `Wrapped entries unavailable, Redis only: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return { cache };
  }
}

export const defaultWrappedDeps: WrappedHandlerDeps = {
  alert: logAlert,
  cache: ApplicationCache,
  members: ApplicationMemberRepository,
  withMeetupClient,
  withOrganizerMeetup,
  limiter: wrappedBuildLimiter,
  now: () => new Date(),
  slowAfterMs: SLOW_BUILD_MS,
  queue: () => PostgresWrappedBackfillRepository.instance(),
  entries: () => PostgresWrappedEntryRepository.instance(),
  snapshot: async () =>
    snapshotWrapped(await PostgresSnapshotRepository.instance()),
  selfPastCount: storedTokenSelfCount,
};

export interface WrappedOptions {
  year: number;
  refresh: boolean;
}

function displayNameOf(
  interaction: CommandInteraction | ButtonInteraction,
): string {
  const { member, user } = interaction;
  const fromGuild =
    member && 'displayName' in member ? member.displayName : undefined;
  return fromGuild ?? user.globalName ?? user.username;
}

/** Keeps the progress reply as the answer (the wrapper would delete it). */
async function answerInPlace(
  interaction: CommandInteraction | ButtonInteraction,
  payload: { content: string; embeds?: ReturnType<typeof wrappedEmbed>[] },
) {
  await interaction.editReply({ ...payload, components: [] });
  keepReplyVisible(interaction);
}

function wrappedPayload(
  interaction: CommandInteraction,
  wrapped: CachedWrapped,
) {
  return {
    embeds: [wrappedEmbed(displayNameOf(interaction), wrapped)],
    // Nothing to share to from a DM.
    components: interaction.inGuild()
      ? [shareButtonRow(wrapped.stats.year, interaction.channelId)]
      : [],
  };
}

export async function runWrapped(
  interaction: CommandInteraction,
  { year, refresh }: WrappedOptions,
  deps: WrappedHandlerDeps = defaultWrappedDeps,
): Promise<void> {
  const userId = interaction.user.id;
  const members = await deps.members();
  // Before any Meetup call: nobody signs in just to be told to link.
  const linkedMeetupId = (await members.findByDiscordId(userId))?.meetupId;
  if (!linkedMeetupId) {
    await answerInPlace(interaction, { content: replies.notLinked });
    return;
  }

  const tiers = await tiersFor(deps);
  const { cache } = tiers;
  // A copy built for a since-replaced Meetup account is a miss.
  const cached = await readEntry(
    tiers,
    userId,
    year,
    linkedMeetupId,
    deps.now(),
  );
  if (cached && !refresh) {
    await interaction.followUp({
      ...wrappedPayload(interaction, cached),
      ephemeral: true,
    });
    return;
  }

  // One build at a time per member and year: a double invoke would otherwise
  // reach the limiter and be told it built "less than an hour ago".
  const lease = buildingKey(userId, year);
  if (
    !(await cache.exclusive_set(
      lease,
      deps.now().toISOString(),
      BUILDING_LEASE_TTL_SEC,
    ))
  ) {
    await answerInPlace(interaction, { content: replies.alreadyBuilding });
    return;
  }
  try {
    const context = { members, tiers, cached, linkedMeetupId, year };
    const fromSnapshot = await snapshotSources(deps, userId, linkedMeetupId);
    if (fromSnapshot) {
      await buildAndReply(interaction, deps, {
        ...context,
        build: (shared) =>
          buildWrappedFromSnapshot(
            { ...shared, attendees: fromSnapshot.snapshot.attendees },
            linkedMeetupId,
            year,
            fromSnapshot.sources,
          ),
      });
    } else {
      await deps.withMeetupClient(interaction, (meetup) =>
        buildAndReply(interaction, deps, {
          ...context,
          build: (shared) =>
            buildWrapped(
              {
                ...shared,
                meetup,
                organizerRsvps: (meetupId) =>
                  deps.withOrganizerMeetup(interaction.client, (organizer) =>
                    organizer.getMemberRsvpEvents(
                      meetupId,
                      Configuration.meetup.groupId,
                      {
                        rsvpStatus: ['YES', 'ATTENDED'],
                        eventStatus: ['PAST'],
                      },
                    ),
                  ),
              },
              linkedMeetupId,
              year,
              Configuration.meetup.groupId,
            ),
        }),
      );
    }
  } finally {
    await cache.remove(lease);
  }
}

/** What both build paths share: the slot, naming, progress, the clock. */
type SharedBuildDeps = Pick<
  BuildDeps,
  'claimBuild' | 'findByMeetupId' | 'isPresent' | 'onProgress' | 'now'
>;

interface BuildContext {
  build: (shared: SharedBuildDeps) => Promise<BuildResult>;
  members: MemberRepository;
  tiers: WrappedTiers;
  cached: CachedWrapped | undefined;
  linkedMeetupId: string;
  year: number;
}

async function buildAndReply(
  interaction: CommandInteraction,
  deps: WrappedHandlerDeps,
  { build, members, tiers, cached, linkedMeetupId, year }: BuildContext,
): Promise<void> {
  const userId = interaction.user.id;
  {
    let slow = false;
    const slowTimer = setTimeout(() => {
      slow = true;
      interaction
        .editReply({ content: replies.stillBuilding, components: [] })
        .catch((error: unknown) => {
          logger.warn(`Could not post the slow-build notice: ${String(error)}`);
        });
    }, deps.slowAfterMs);

    let claimed = false;
    try {
      const result: BuildResult = await build({
        // Taken only with the token in hand and the history readable (or,
        // from the snapshot, right away): a member sent on the OAuth hop, or
        // told to reconnect, keeps their slot for the next attempt.
        claimBuild: () => {
          claimed = deps.limiter.take(userId);
          return claimed;
        },
        findByMeetupId: (meetupId) => members.findByMeetupId(meetupId),
        isPresent: async (discordUserId) => {
          if (!interaction.guild) {
            return true;
          }
          try {
            await interaction.guild.members.fetch(discordUserId);
            return true;
          } catch {
            return false;
          }
        },
        onProgress: async (message) => {
          if (!slow) {
            await interaction.editReply({ content: message, components: [] });
          }
        },
        now: () => deps.now(),
      });

      if (result.kind === 'account-mismatch') {
        logger.warn(
          `Wrapped: token account ${result.tokenMeetupId} is not the linked account for Discord user ${userId}`,
        );
        await answerInPlace(interaction, { content: replies.accountMismatch });
        return;
      }
      if (result.kind === 'not-in-group') {
        await answerInPlace(interaction, { content: replies.notInGroup });
        return;
      }
      if (result.kind === 'rate-limited') {
        const minutes = Math.ceil(deps.limiter.retryAfterSec(userId) / 60);
        let content = replies.rateLimited(minutes);
        if (!cached && deps.queue) {
          // Nothing to show: queue it for the backfill tick instead of only
          // "try again". A copy that appeared meanwhile is not queued.
          try {
            const outcome = await queueForLater(
              await deps.queue(),
              tiers,
              { discordUserId: userId, meetupId: linkedMeetupId },
              year,
              deps.now(),
            );
            if (outcome.kind !== 'cached') {
              content += `\n${queuedText(outcome, discordClock)}`;
            }
          } catch (queueError) {
            logger.warn(
              `Could not queue the Wrapped: ${queueError instanceof Error ? queueError.name : 'Error'}`,
            );
          }
        }
        await answerInPlace(interaction, {
          content,
          embeds: cached
            ? [wrappedEmbed(displayNameOf(interaction), cached)]
            : [],
        });
        return;
      }

      await writeEntry(tiers, userId, year, result.wrapped, deps.now());
      if (deps.queue) {
        // An on-demand build makes a queued request for this year moot.
        try {
          await (await deps.queue()).complete(userId, year);
        } catch {
          // The tick drops it as fresh.
        }
      }
      const payload = wrappedPayload(interaction, result.wrapped);
      if (slow) {
        try {
          await interaction.user.send(payload);
          return;
        } catch (error) {
          logger.warn(
            `Could not DM a Wrapped, using the follow-up: ${String(error)}`,
          );
        }
      }
      await interaction.followUp({ ...payload, ephemeral: true });
    } catch (error) {
      // Covers the Meetup reads, the cache write and the delivery alike.
      if (claimed) {
        // The member got nothing for the slot; don't lock them out an hour.
        deps.limiter.release(userId);
      }
      // Full error to the process log only; Discord gets a composed summary
      // (a graphql-request ClientError's message embeds Meetup's response
      // body, issue #112) and the member a fixed line, in place: a transient
      // failure is not "reach out to a moderator".
      logger.error(error);
      // The alert and the answer are each best-effort (#138 review): a
      // failing alert channel must still leave the member an answer in
      // place, and neither may surface as a second failure to the wrapper.
      try {
        await deps.alert(interaction.client, {
          title: '/wrapped failed',
          description:
            `User: ${interaction.user.toString()} (${interaction.user.username})\n` +
            `Error: ${describeBuildError(error)}`,
        });
      } catch (alertError) {
        logger.warn(`Could not post the /wrapped alert: ${String(alertError)}`);
      }
      try {
        await answerInPlace(interaction, { content: replies.buildFailed });
      } catch (replyError) {
        logger.warn(
          `Could not answer the /wrapped failure: ${String(replyError)}`,
        );
      }
    } finally {
      clearTimeout(slowTimer);
    }
  }
}

/**
 * The channel a share may go to, and the clicker as a member of it; undefined
 * when the bot can't post there or the clicker can no longer see it.
 */
async function shareTarget(
  interaction: ButtonInteraction,
  channelId: string,
): Promise<
  { channel: GuildTextBasedChannel; member: GuildMember } | undefined
> {
  // Deleted, or the bot can't see it any more: the same answer as "not a
  // channel it can post in".
  let channel: Channel | null | undefined;
  try {
    channel = await interaction.client.channels.fetch(channelId);
  } catch {
    channel = undefined;
  }
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    return undefined;
  }
  let member: GuildMember;
  try {
    member = await channel.guild.members.fetch(interaction.user.id);
  } catch {
    return undefined;
  }
  const sendBit = channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  // The clicker must be able to post there themselves: the bot posts on
  // their behalf, never into a channel they couldn't write to.
  if (
    !channel
      .permissionsFor(member)
      ?.has([PermissionFlagsBits.ViewChannel, sendBit])
  ) {
    return undefined;
  }
  const bot = interaction.client.user;
  if (
    !bot ||
    !channel
      .permissionsFor(bot)
      ?.has([
        PermissionFlagsBits.ViewChannel,
        sendBit,
        PermissionFlagsBits.EmbedLinks,
      ])
  ) {
    return undefined;
  }
  return { channel, member };
}

export async function runShare(
  interaction: ButtonInteraction,
  deps: WrappedHandlerDeps = defaultWrappedDeps,
): Promise<void> {
  const parsed = parseShareCustomId(interaction.customId);
  if (!parsed) {
    throw new Error(`Unexpected share button id: ${interaction.customId}`);
  }
  const { year, channelId } = parsed;
  const userId = interaction.user.id;
  const tiers = await tiersFor(deps);
  const { cache } = tiers;

  // Always the clicker's own Wrapped, whichever message the button sits on,
  // and only one built for the Meetup account they are linked to now.
  const linkedMeetupId = (await (await deps.members()).findByDiscordId(userId))
    ?.meetupId;
  const wrapped = linkedMeetupId
    ? await readEntry(tiers, userId, year, linkedMeetupId, deps.now())
    : undefined;
  if (!wrapped) {
    await answerInPlace(interaction, { content: replies.shareExpired });
    return;
  }

  const guardKey = shareGuardKey(userId, year, channelId);
  if (
    !(await cache.exclusive_set(guardKey, wrapped.builtAt, SHARE_GUARD_TTL_SEC))
  ) {
    await answerInPlace(interaction, { content: replies.alreadyShared });
    return;
  }

  const target = await shareTarget(interaction, channelId);
  if (!target) {
    await cache.remove(guardKey);
    await answerInPlace(interaction, { content: replies.cannotShareHere });
    return;
  }

  // Public post: companions as plain server display names, never tags
  // (Hai, 2026-11-10). One who has left since is folded into the count.
  const displayNames: Record<string, string> = {};
  await Promise.all(
    wrapped.companions.named.map(async ({ discordUserId }) => {
      try {
        const companion =
          await target.channel.guild.members.fetch(discordUserId);
        displayNames[discordUserId] = companion.displayName;
      } catch {
        // Not on the server any more: counted, not named.
      }
    }),
  );

  try {
    await target.channel.send({
      content: sharedPostContent(userId, year),
      embeds: [
        wrappedEmbed(target.member.displayName, wrapped, {
          kind: 'shared',
          displayNames,
        }),
      ],
      // Mentions render, nobody is notified.
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    // Nothing was posted, so the member may try again.
    await cache.remove(guardKey);
    throw error;
  }
  await interaction.followUp({ content: replies.shared, ephemeral: true });
}

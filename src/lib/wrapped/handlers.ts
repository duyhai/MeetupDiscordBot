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
import { MemberRepository } from '../repositories/types.js';
import { describeBuildError } from '../reports/buildJob.js';
import { withOrganizerMeetup } from '../reports/organizerMeetup.js';
import { ApplicationCache } from '../../util/cache.js';
import { keepReplyVisible } from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';
import { FixedWindowLimiter } from '../../web/rateLimit.js';
import { BuildResult, buildWrapped } from './build.js';
import {
  BUILDING_LEASE_TTL_SEC,
  CachedWrapped,
  SHARE_GUARD_TTL_SEC,
  buildingKey,
  readWrapped,
  shareGuardKey,
  wrappedBuildLimiter,
  writeWrapped,
} from './cache.js';
import {
  parseShareCustomId,
  replies,
  shareButtonRow,
  sharedPostContent,
  wrappedEmbed,
} from './format.js';

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
};

/**
 * What the member sees when Meetup (or the organizer credential) failed
 * mid-build. The wrapper would otherwise post the raw error, which for a
 * graphql-request ClientError embeds Meetup's response body (issue #112);
 * this one carries a fixed message and marks the alert as already posted.
 */
export class WrappedBuildError extends Error {
  readonly alertHandled = true;

  constructor() {
    super(replies.buildFailed);
    this.name = 'WrappedBuildError';
  }
}

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

  const cache = await deps.cache();
  // A copy built for a since-replaced Meetup account is a miss.
  const cached = await readWrapped(cache, userId, year, linkedMeetupId);
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
    await deps.withMeetupClient(interaction, (meetup) =>
      buildAndReply(interaction, deps, {
        meetup,
        members,
        cache,
        cached,
        linkedMeetupId,
        year,
      }),
    );
  } finally {
    await cache.remove(lease);
  }
}

interface BuildContext {
  meetup: Parameters<Parameters<typeof withMeetupClient>[1]>[0];
  members: MemberRepository;
  cache: KeyValueCache;
  cached: CachedWrapped | undefined;
  linkedMeetupId: string;
  year: number;
}

async function buildAndReply(
  interaction: CommandInteraction,
  deps: WrappedHandlerDeps,
  { meetup, members, cache, cached, linkedMeetupId, year }: BuildContext,
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
    let result: BuildResult;
    try {
      result = await buildWrapped(
        {
          meetup,
          // Taken only with the token in hand and the history readable: a
          // member sent on the OAuth hop, or told to reconnect, keeps their
          // slot for the next attempt.
          claimBuild: () => {
            claimed = deps.limiter.take(userId);
            return claimed;
          },
          organizerRsvps: (meetupId) =>
            deps.withOrganizerMeetup(interaction.client, (organizer) =>
              organizer.getMemberRsvpEvents(
                meetupId,
                Configuration.meetup.groupId,
                { rsvpStatus: ['YES', 'ATTENDED'], eventStatus: ['PAST'] },
              ),
            ),
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
        },
        linkedMeetupId,
        year,
        Configuration.meetup.groupId,
      );
    } catch (error) {
      clearTimeout(slowTimer);
      if (claimed) {
        // The member got nothing for the slot; don't lock them out an hour.
        deps.limiter.release(userId);
      }
      logger.error(error);
      await deps.alert(interaction.client, {
        title: '/wrapped failed',
        description:
          `User: ${interaction.user.toString()} (${interaction.user.username})\n` +
          `Error: ${describeBuildError(error)}`,
      });
      throw new WrappedBuildError();
    }
    clearTimeout(slowTimer);

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
      await answerInPlace(interaction, {
        content: replies.rateLimited(minutes),
        embeds: cached
          ? [wrappedEmbed(displayNameOf(interaction), cached)]
          : [],
      });
      return;
    }

    await writeWrapped(cache, userId, year, result.wrapped, deps.now());
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
  const cache = await deps.cache();

  // Always the clicker's own Wrapped, whichever message the button sits on,
  // and only one built for the Meetup account they are linked to now.
  const linkedMeetupId = (await (await deps.members()).findByDiscordId(userId))
    ?.meetupId;
  const wrapped = linkedMeetupId
    ? await readWrapped(cache, userId, year, linkedMeetupId)
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

  try {
    await target.channel.send({
      content: sharedPostContent(userId, year),
      embeds: [wrappedEmbed(target.member.displayName, wrapped)],
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

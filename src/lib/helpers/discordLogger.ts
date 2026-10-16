import {
  Client,
  EmbedBuilder,
  MessageMentionOptions,
  TextChannel,
} from 'discord.js';
import { Logger } from 'tslog';

import {
  BOT_ACTIVITY_LOG_CHANNEL_ID,
  BOT_ALERTS_CHANNEL_ID,
  EMBED_COLORS,
  MODERATION_LOG_CHANNEL_ID,
} from '../../constants.js';

const logger = new Logger({ name: 'discordLogger' });

export interface LogEntry {
  description?: string;
  fields?: { inline?: boolean; name: string; value: string }[];
  title: string;
}

interface PostOptions {
  allowedMentions: MessageMentionOptions;
  content?: string;
}

/**
 * Only the error's class name and HTTP status: a Discord error message can
 * echo what was sent, and a notice's content must stay out of the log.
 */
function describeSendError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const { status } = error as { status?: unknown };
  return typeof status === 'number'
    ? `${error.name} (HTTP ${status})`
    : error.name;
}

/**
 * Posts an embed to a log channel. Deliberately swallows every error:
 * Discord logging must never break the command that triggered it.
 *
 * Returns whether the post actually landed. Most callers ignore it -- but a
 * caller that consumed a once-a-day claim to get here needs to know, or an
 * outage silently costs the whole day's digest with no retry.
 */
async function postToChannel(
  client: Client,
  channelId: string,
  color: number,
  entry: LogEntry,
  // Log entries mention users for readability; by default never ping them.
  options: PostOptions = { allowedMentions: { parse: [] } },
): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!(channel instanceof TextChannel)) {
      logger.warn(`Log channel ${channelId} is missing or not a text channel`);
      return false;
    }
    const embed = new EmbedBuilder()
      .setTitle(entry.title)
      .setColor(color)
      .setTimestamp(new Date());
    if (entry.description) {
      embed.setDescription(entry.description);
    }
    (entry.fields ?? []).forEach((field) => {
      embed.addFields(field);
    });
    await channel.send({
      ...(options.content !== undefined && { content: options.content }),
      embeds: [embed],
      allowedMentions: options.allowedMentions,
    });
    return true;
  } catch (error) {
    logger.warn(
      `Failed to post log entry "${entry.title}": ${describeSendError(error)}`,
    );
    return false;
  }
}

export async function logActivity(
  client: Client,
  entry: LogEntry,
): Promise<boolean> {
  return postToChannel(
    client,
    BOT_ACTIVITY_LOG_CHANNEL_ID,
    EMBED_COLORS.activity,
    entry,
  );
}

/** No-show reports, suspension records, and voids, for staff only. */
export async function logModeration(
  client: Client,
  entry: LogEntry,
): Promise<boolean> {
  return postToChannel(
    client,
    MODERATION_LOG_CHANNEL_ID,
    EMBED_COLORS.activity,
    entry,
  );
}

export async function logAlert(
  client: Client,
  entry: LogEntry,
): Promise<boolean> {
  return postToChannel(
    client,
    BOT_ALERTS_CHANNEL_ID,
    EMBED_COLORS.alert,
    entry,
  );
}

/**
 * Posts an embed plus `content` to a channel, letting exactly `roleIds` ping
 * (embeds never ping, so mentions must be in content). Never pings users,
 * @everyone or other roles. Swallows errors like the other log functions;
 * returns whether the post landed.
 */
export async function postRoleNotice(
  client: Client,
  channelId: string,
  roleIds: string[],
  content: string,
  entry: LogEntry,
): Promise<boolean> {
  return postToChannel(client, channelId, EMBED_COLORS.info, entry, {
    content,
    allowedMentions: { parse: [], roles: [...roleIds] },
  });
}

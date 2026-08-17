import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { Logger } from 'tslog';

import {
  BOT_ACTIVITY_LOG_CHANNEL_ID,
  BOT_ALERTS_CHANNEL_ID,
  EMBED_COLORS,
} from '../../constants.js';

const logger = new Logger({ name: 'discordLogger' });

export interface LogEntry {
  description?: string;
  fields?: { inline?: boolean; name: string; value: string }[];
  title: string;
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
      embeds: [embed],
      // Log entries mention users for readability; never ping them.
      allowedMentions: { parse: [] },
    });
    return true;
  } catch (error) {
    logger.warn(`Failed to post log entry "${entry.title}": ${String(error)}`);
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

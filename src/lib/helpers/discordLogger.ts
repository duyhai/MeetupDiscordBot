import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { Logger } from 'tslog';

import {
  BOT_ACTIVITY_LOG_CHANNEL_ID,
  BOT_ALERTS_CHANNEL_ID,
} from '../../constants.js';

const logger = new Logger({ name: 'discordLogger' });

const COLORS = {
  activity: 0x2ecc71, // green
  alert: 0xe74c3c, // red
};

export interface LogEntry {
  description?: string;
  fields?: { inline?: boolean; name: string; value: string }[];
  title: string;
}

/**
 * Posts an embed to a log channel. Deliberately swallows every error:
 * Discord logging must never break the command that triggered it.
 */
async function postToChannel(
  client: Client,
  channelId: string,
  color: number,
  entry: LogEntry,
): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!(channel instanceof TextChannel)) {
      logger.warn(`Log channel ${channelId} is missing or not a text channel`);
      return;
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
  } catch (error) {
    logger.warn(`Failed to post log entry "${entry.title}": ${String(error)}`);
  }
}

export async function logActivity(
  client: Client,
  entry: LogEntry,
): Promise<void> {
  await postToChannel(
    client,
    BOT_ACTIVITY_LOG_CHANNEL_ID,
    COLORS.activity,
    entry,
  );
}

export async function logAlert(client: Client, entry: LogEntry): Promise<void> {
  await postToChannel(client, BOT_ALERTS_CHANNEL_ID, COLORS.alert, entry);
}

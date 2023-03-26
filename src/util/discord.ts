import crypto from 'crypto';
import fs from 'fs';
import {
  CommandInteraction,
  GuildMember,
  PermissionFlagsBits,
  WebhookEditMessageOptions,
} from 'discord.js';

/**
 * A wrapper for Discord commands to handle:
 * 1. Deferred reply: Command implementation either edit or follow up
 * 2. Error handling: Retriable or fatal
 * @param commandFn Lambda for command implementation
 */
export async function discordCommandWrapper(
  interaction: CommandInteraction,
  commandFn: () => Promise<void>
) {
  await interaction.deferReply({ ephemeral: true });
  try {
    await commandFn();
  } catch (error: unknown) {
    if (error instanceof Error) {
      await interaction.editReply({
        content: `Error: ${error.message}. Please reach out to a moderator for help.`,
      });
    }
  }
}

/**
 * A wrapper for Discord to attach files. It handles cleaning up the files
 * @param title Title of the attachment
 * @param attachmentDataGen The callback that generates the data for the attachment
 * @param attachmentHandler The callback that gets to use the attachmentArgs
 * @param description Description of the fileAttachment
 */
export async function withDiscordAttachment(
  title: string,
  attachmentData: string | NodeJS.ArrayBufferView,
  attachmentHandler: (
    attachmentArgs: Pick<WebhookEditMessageOptions, 'files' | 'embeds'>
  ) => Promise<void>,
  description?: string
) {
  const tmpFileName = `${crypto.randomBytes(16).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpFileName, attachmentData);
    await attachmentHandler({
      embeds: [
        {
          description,
          image: {
            url: `attachment://${title}`,
          },
        },
      ],
      files: [
        {
          attachment: tmpFileName,
          name: title,
        },
      ],
    });
  } finally {
    if (fs.existsSync(tmpFileName)) {
      fs.rmSync(tmpFileName);
    }
  }
}

export function isAdmin(member: GuildMember) {
  return member.permissions.has(PermissionFlagsBits.Administrator, true);
}

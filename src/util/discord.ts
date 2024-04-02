import crypto from 'crypto';
import fs from 'fs';
import {
  ButtonInteraction,
  CommandInteraction,
  GuildMember,
  PermissionFlagsBits,
  WebhookMessageEditOptions,
} from 'discord.js';
import { Logger } from 'tslog';

const logger = new Logger({ name: 'DiscordUtil' });

/**
 * A wrapper for Discord commands to handle:
 * 1. Deferred reply: Command implementation either edit for in progress messages
 * and follow up for messsages that should stick around after command is done
 * 2. Error handling: Retriable or fatal
 * @param commandFn Lambda for command implementation
 */
export async function discordCommandWrapper(
  interaction: ButtonInteraction | CommandInteraction,
  commandFn: () => Promise<void>
) {
  const message = await interaction.reply({
    content: 'Executing command',
    ephemeral: true,
  });
  try {
    await commandFn();
    await message.delete();
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.error(error);
      await interaction.editReply({
        content: `${interaction.user.toString()} Error: ${
          error?.message
        }. Please reach out to a moderator for help.`,
      });
    }
  }
}

/**
 * A wrapper for Discord to attach files. It handles cleaning up the files
 * @param fileName Attachment file name
 * @param attachmentData The data for the attachment
 * @param attachmentHandler The callback that gets to use the attachmentArgs
 */
export async function withDiscordFileAttachment(
  fileName: string,
  attachmentData: string | NodeJS.ArrayBufferView,
  attachmentHandler: (
    attachmentArgs: Pick<WebhookMessageEditOptions, 'files'>
  ) => Promise<void>
) {
  const tmpFileName = `${crypto.randomBytes(16).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpFileName, attachmentData);
    await attachmentHandler({
      files: [
        {
          attachment: tmpFileName,
          name: fileName,
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

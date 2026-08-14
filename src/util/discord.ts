import crypto from 'crypto';
import fs from 'fs';
import {
  ButtonInteraction,
  CommandInteraction,
  GuildMember,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  WebhookMessageEditOptions,
} from 'discord.js';
import { Logger } from 'tslog';

import { SERVER_ROLES, ServerRoles } from '../constants.js';
import { logActivity, logAlert } from '../lib/helpers/discordLogger.js';

const logger = new Logger({ name: 'DiscordUtil' });

export function describeInteraction(
  interaction: ButtonInteraction | CommandInteraction | ModalSubmitInteraction,
): string {
  if (interaction.isChatInputCommand?.()) {
    return `/${interaction.commandName}`;
  }
  if ('commandName' in interaction) {
    return `/${interaction.commandName}`;
  }
  if (interaction.isButton?.()) {
    return `button:${interaction.customId}`;
  }
  return `modal:${interaction.customId}`;
}

/**
 * A wrapper for Discord commands to handle:
 * 1. Deferred reply: Command implementation either edit for in progress messages
 * and follow up for messsages that should stick around after command is done
 * 2. Error handling: Retriable or fatal
 * @param commandFn Lambda for command implementation
 */
export async function discordCommandWrapper(
  interaction: ButtonInteraction | CommandInteraction | ModalSubmitInteraction,
  commandFn: () => Promise<void>,
) {
  const message = await interaction.reply({
    content: 'Executing command',
    ephemeral: true,
  });
  const action = describeInteraction(interaction);
  try {
    await commandFn();
    await message.delete();
    await logActivity(interaction.client, {
      title: `${action} used`,
      description: `By ${interaction.user.toString()} (${
        interaction.user.username
      })`,
    });
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.error(error);
      await logAlert(interaction.client, {
        title: `${action} failed`,
        description: `User: ${interaction.user.toString()} (${
          interaction.user.username
        })\nError: ${error.message}`,
      });
      await interaction.editReply({
        content: `${interaction.user.toString()} Error: ${
          error?.message
        } Please reach out to a moderator for help.`,
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
    attachmentArgs: Pick<WebhookMessageEditOptions, 'files'>,
  ) => Promise<void>,
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

export function hasAnyServerRole(member: GuildMember, roles: ServerRoles[]) {
  return roles.some((role) => member.roles.cache.has(SERVER_ROLES[role]));
}

export function linkStr(text: string, link: string) {
  return `[${text}](${link})`;
}

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
import { disposeReplyStack, replyStack } from '../lib/messageStack/registry.js';
import { describeInteraction } from './describeInteraction.js';

const logger = new Logger({ name: 'DiscordUtil' });

export { describeInteraction } from './describeInteraction.js';

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
  await interaction.deferReply({ ephemeral: true });
  const action = describeInteraction(interaction);
  const stack = replyStack(interaction);
  // Seeded so a slow command shows progress; removed before returning, so a
  // command finishing inside the debounce window never renders it at all.
  const workingId = stack.ephemeral.append({
    content: 'Working on it…',
    status: 'pending',
  });
  try {
    await commandFn();
    stack.ephemeral.remove(workingId);
    await logActivity(interaction.client, {
      title: `${action} used`,
      description: `By ${interaction.user.toString()} (${
        interaction.user.username
      })`,
    });
  } catch (thrown: unknown) {
    // Non-Error throws (a bare string, a rejected promise carrying a plain
    // object) must still clear the seeded pending entry and alert -- else
    // the "Working on it…" banner would flush as the command's permanent
    // output with nobody notified.
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    logger.error(error);
    stack.ephemeral.update(workingId, {
      content: `${error.message} Please reach out to a moderator for help.`,
      status: 'error',
    });
    // Errors marked alertHandled (e.g. DuplicateMeetupAccountError) posted
    // their own, more specific alert at the throw site.
    const alertHandled =
      (error as { alertHandled?: boolean }).alertHandled === true;
    if (!alertHandled) {
      await logAlert(interaction.client, {
        title: `${action} failed`,
        description: `User: ${interaction.user.toString()} (${
          interaction.user.username
        })\nError: ${error.message}`,
      });
    }
  } finally {
    await stack.flushAll();
    disposeReplyStack(interaction);
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

/**
 * Throws with the given message unless the invoking member is an admin,
 * moderator, or organizer. Widen a command's audience by passing more roles.
 */
export async function requireModOrOrganizer(
  interaction: CommandInteraction,
  errorMessage: string,
  roles: ServerRoles[] = ['moderator', 'organizer'],
) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!isAdmin(member) && !hasAnyServerRole(member, roles)) {
    throw new Error(errorMessage);
  }
}

export function linkStr(text: string, link: string) {
  return `[${text}](${link})`;
}

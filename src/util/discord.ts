import {
  CommandInteraction,
  GuildMember,
  PermissionFlagsBits,
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

export function isAdmin(member: GuildMember) {
  return member.permissions.has(PermissionFlagsBits.Administrator, true);
}

import { Client, DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';

import { GUILD_ID, SERVER_ROLES } from '../constants.js';

/**
 * Who may use the staff dashboard: Moderators and the 1.5 Leadership Team.
 * Event Organizers are deliberately excluded, matching the moderation
 * commands, and so is the Administrator permission on its own: the dashboard
 * shows disciplinary records, and the approved spec names roles only.
 */
export const DASHBOARD_ROLE_IDS: string[] = [
  SERVER_ROLES.moderator,
  SERVER_ROLES.leadership,
];

export function hasDashboardRole(roleIds: Iterable<string>): boolean {
  for (const id of roleIds) {
    if (DASHBOARD_ROLE_IDS.includes(id)) {
      return true;
    }
  }
  return false;
}

export type AccessCheck = (discordUserId: string) => Promise<boolean>;

/** The bot is not logged in to Discord yet, so no one can be checked. */
export class DashboardUnavailableError extends Error {}

/**
 * Asks Discord, not the member cache: `force` bypasses discord.js's cache so
 * a role removed a minute ago is already gone here. A member who left the
 * server (Unknown Member) is a plain denial; any other failure propagates so
 * the caller can refuse with "try again" instead of guessing.
 */
export function discordAccessCheck(
  getClient: () => Client | undefined,
): AccessCheck {
  return async (discordUserId) => {
    const client = getClient();
    if (!client) {
      throw new DashboardUnavailableError('Discord client is not ready');
    }
    const guild = await client.guilds.fetch(GUILD_ID);
    try {
      const member = await guild.members.fetch({
        user: discordUserId,
        force: true,
      });
      return hasDashboardRole(member.roles.cache.keys());
    } catch (error: unknown) {
      if (
        error instanceof DiscordAPIError &&
        (error.code === RESTJSONErrorCodes.UnknownMember ||
          error.code === RESTJSONErrorCodes.UnknownUser)
      ) {
        return false;
      }
      throw error;
    }
  };
}

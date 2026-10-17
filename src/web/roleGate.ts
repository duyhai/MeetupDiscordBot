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
 * The member's role ids, asked of Discord rather than the member cache:
 * `force` bypasses discord.js's cache so a role removed a minute ago is
 * already gone here. A member who left the server (Unknown Member or Unknown
 * User) has no roles; any other failure propagates so the caller can refuse
 * with "try again" instead of guessing.
 */
async function freshRoleIds(
  getClient: () => Client | undefined,
  discordUserId: string,
): Promise<string[]> {
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
    return [...member.roles.cache.keys()];
  } catch (error: unknown) {
    if (
      error instanceof DiscordAPIError &&
      (error.code === RESTJSONErrorCodes.UnknownMember ||
        error.code === RESTJSONErrorCodes.UnknownUser)
    ) {
      return [];
    }
    throw error;
  }
}

/** Holds a dashboard role, checked live (see freshRoleIds). */
export function discordAccessCheck(
  getClient: () => Client | undefined,
): AccessCheck {
  return async (discordUserId) =>
    hasDashboardRole(await freshRoleIds(getClient, discordUserId));
}

/**
 * Holds one specific role, checked live (see freshRoleIds). Used for the
 * 1.5 Leadership Team check before one staff member signs out another.
 */
export function discordRoleCheck(
  getClient: () => Client | undefined,
  roleId: string,
): AccessCheck {
  return async (discordUserId) =>
    (await freshRoleIds(getClient, discordUserId)).includes(roleId);
}

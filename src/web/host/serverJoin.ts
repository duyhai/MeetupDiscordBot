import {
  Client,
  DiscordAPIError,
  GuildMember,
  RESTJSONErrorCodes,
} from 'discord.js';

import { GUILD_ID } from '../../constants.js';

/** Where the member stands in our Discord server after a join attempt. */
export interface ServerJoin {
  /** True when this call added them (they were not a member before). */
  joined: boolean;
  /**
   * Membership Screening: an OAuth-joined member waits here until they
   * accept the server rules in Discord. Nothing else can grant them roles
   * that matter until then.
   */
  pending: boolean;
  member: GuildMember;
}

/**
 * Makes sure the Discord user is in our server: a member already is left as
 * they are; anyone else is added with THEIR OAuth access token (scope
 * guilds.join), never the bot's, which is how Discord lets a bot add a user
 * who asked for it. The bot needs Create Invite in the server. Throws when
 * Discord cannot answer or refuses the add.
 */
export async function ensureServerMember(
  getClient: () => Client | undefined,
  discordUserId: string,
  accessToken: string,
): Promise<ServerJoin> {
  const client = getClient();
  if (!client) {
    throw new Error('Discord client is not ready');
  }
  const guild = await client.guilds.fetch(GUILD_ID);
  try {
    const member = await guild.members.fetch({
      user: discordUserId,
      force: true,
    });
    return { joined: false, pending: Boolean(member.pending), member };
  } catch (error: unknown) {
    if (!(
      error instanceof DiscordAPIError &&
      error.code === RESTJSONErrorCodes.UnknownMember
    )) {
      throw error;
    }
  }
  // null when Discord says they are already a member (204): a race with
  // their own join, so fetch them like any member.
  const added = await guild.members.add(discordUserId, { accessToken });
  const member =
    added ?? (await guild.members.fetch({ user: discordUserId, force: true }));
  return { joined: added !== null, pending: Boolean(member.pending), member };
}

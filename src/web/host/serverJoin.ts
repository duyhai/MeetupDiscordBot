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
    // Not in the server (Unknown Member, or Unknown User as isServerMember
    // also reads it): add them. Anything else is Discord failing.
    const notInServer =
      error instanceof DiscordAPIError &&
      (error.code === RESTJSONErrorCodes.UnknownMember ||
        error.code === RESTJSONErrorCodes.UnknownUser);
    if (!notInServer) {
      throw error;
    }
  }
  // null when Discord says they are already a member (204): a race with
  // their own join, so fetch them like any member. fetchWhenExisting:
  // false, or discord.js fetches them itself and the 204 looks like a join.
  const added = await guild.members.add(discordUserId, {
    accessToken,
    fetchWhenExisting: false,
  });
  const member =
    added ?? (await guild.members.fetch({ user: discordUserId, force: true }));
  return { joined: added !== null, pending: Boolean(member.pending), member };
}

/**
 * Whether the Discord user is in our server, asked of Discord with the bot.
 * Throws when Discord cannot answer.
 */
export async function isServerMember(
  getClient: () => Client | undefined,
  discordUserId: string,
): Promise<boolean> {
  const client = getClient();
  if (!client) {
    throw new Error('Discord client is not ready');
  }
  const guild = await client.guilds.fetch(GUILD_ID);
  try {
    await guild.members.fetch({ user: discordUserId, force: true });
    return true;
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
}

/**
 * The Discord username for an id, asked with the bot; undefined if Discord
 * does not know it or takes longer than `timeoutMs` (it only names an
 * account on an error page, which an outage must not slow down).
 */
export async function discordUsername(
  getClient: () => Client | undefined,
  discordUserId: string,
  timeoutMs = 2000,
): Promise<string | undefined> {
  const client = getClient();
  if (!client) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      client.users.fetch(discordUserId).then((user) => user.username),
      timeout,
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

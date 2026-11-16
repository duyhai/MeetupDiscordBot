import {
  Client,
  DiscordAPIError,
  GuildMember,
  RESTJSONErrorCodes,
  Status,
} from 'discord.js';
import { Logger } from 'tslog';

import { GUILD_ID } from '../../constants.js';

const logger = new Logger({ name: 'serverJoin' });

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

/**
 * One member's server display name over REST (the bot's member cache
 * first): the name; null when Discord says they are not on the server;
 * undefined when it could not tell (slow, down, or no bot). Never throws.
 */
async function memberName(
  client: Client,
  discordUserId: string,
  timeoutMs: number,
): Promise<string | null | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const guild = await client.guilds.fetch(GUILD_ID);
        const cached = guild.members.cache.get(discordUserId);
        if (cached) {
          return cached.displayName;
        }
        return (await guild.members.fetch(discordUserId)).displayName;
      })(),
      timeout,
    ]);
  } catch (error: unknown) {
    return error instanceof DiscordAPIError &&
      (error.code === RESTJSONErrorCodes.UnknownMember ||
        error.code === RESTJSONErrorCodes.UnknownUser)
      ? null
      : undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The server display name (nickname, else global name, else username) of a
 * member of our server, for naming a linked Wrapped companion on the
 * website. The bot's guild member cache first; a miss is fetched, bounded
 * by `timeoutMs` so a slow Discord never holds a page. undefined when they
 * are not on the server, Discord is slow or the bot is not ready: the page
 * then counts them instead of naming them.
 */
export async function displayName(
  getClient: () => Client | undefined,
  discordUserId: string,
  timeoutMs = 2000,
): Promise<string | undefined> {
  const client = getClient();
  if (!client) {
    return undefined;
  }
  return (await memberName(client, discordUserId, timeoutMs)) ?? undefined;
}

/**
 * Names the bot already holds in memory (its guild member cache, kept
 * current by member events under the GuildMembers intent): no request.
 * Ids it does not hold are left out.
 */
export function cachedDisplayNames(
  getClient: () => Client | undefined,
  discordUserIds: string[],
): Record<string, string> {
  const members = getClient()?.guilds.cache.get(GUILD_ID)?.members.cache;
  const names: Record<string, string> = {};
  if (members) {
    discordUserIds.forEach((id) => {
      const member = members.get(id);
      if (member) {
        names[id] = member.displayName;
      }
    });
  }
  return names;
}

/** Up to this many misses are read one by one over REST: one window of Discord's guild-member bucket (five reads). */
export const SINGLE_READS_MAX = 5;
/** Discord's cap on user_ids in one request-guild-members. */
const BATCH_MAX = 100;
/** The gateway request's own timeout, inside the overall budget. */
const BATCH_TIMEOUT_MS = 3000;

/**
 * Display names for several members at once, for a Wrapped naming ~20
 * people: a name; null when Discord says they are not on the server; left
 * out when it could not tell in time (counted, not named, and not
 * remembered as gone). The bot's member cache first; up to
 * SINGLE_READS_MAX misses go over REST like displayName; more go in one
 * gateway request-guild-members by id (one round trip, where REST queues
 * them five to a window, measured at 2–3 s for 20), but only while the
 * shard is Ready: during a reconnect discord.js would throw from an
 * un-awaited send (an unhandled rejection) or queue the request past its
 * timeout. Any failure there (a gateway rate limit, the timeout) falls back
 * to the REST reads. The whole call stays within `budgetMs`. Never throws.
 */
export async function displayNames(
  getClient: () => Client | undefined,
  discordUserIds: string[],
  budgetMs = 4000,
): Promise<Record<string, string | null>> {
  const deadline = Date.now() + budgetMs;
  const names: Record<string, string | null> = {};
  const client = getClient();
  if (!client || discordUserIds.length === 0) {
    return names;
  }
  let missing: string[];
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    missing = discordUserIds.filter((id) => {
      const cached = guild.members.cache.get(id);
      if (cached) {
        names[id] = cached.displayName;
        return false;
      }
      return true;
    });
    if (
      missing.length > SINGLE_READS_MAX &&
      guild.shard?.status === Status.Ready
    ) {
      for (let i = 0; i < missing.length; i += BATCH_MAX) {
        const chunk = missing.slice(i, i + BATCH_MAX);
        // eslint-disable-next-line no-await-in-loop -- rarely a second batch; one gateway request at a time
        const fetched = await guild.members.fetch({
          user: chunk,
          time: Math.max(1, Math.min(BATCH_TIMEOUT_MS, deadline - Date.now())),
        });
        // The chunk answers for every id asked: whoever is not in it is
        // not on the server.
        chunk.forEach((id) => {
          const member = fetched.get(id);
          names[id] = member ? member.displayName : null;
        });
      }
      return names;
    }
  } catch (error: unknown) {
    // The REST reads below, for whoever is still unanswered.
    logger.warn(
      `Batched member names failed, reading one by one: ${error instanceof Error ? error.name : 'Error'}`,
    );
    missing = discordUserIds.filter((id) => names[id] === undefined);
  }
  const left = deadline - Date.now();
  if (left <= 0) {
    return names;
  }
  await Promise.all(
    missing.map(async (id) => {
      const name = await memberName(client, id, left);
      if (name !== undefined) {
        names[id] = name;
      }
    }),
  );
  return names;
}

import { Client, GuildMember, PartialGuildMember } from 'discord.js';
import { Logger } from 'tslog';

import { GUILD_ID } from '../../constants.js';
import { ApplicationCache } from '../../util/cache.js';
import { forgetMeetupTokens } from './meetupTokens.js';

const logger = new Logger({ name: 'MemberLeave' });

/**
 * Drops the saved Meetup connection of someone who is no longer in the
 * server, so their credentials do not sit in the cache for the rest of the
 * retention window with nobody to use them.
 *
 * Only the token set goes. The member record, the identity baseline and any
 * suspension records are deliberately left alone: someone who rejoins should
 * still be recognised, and bans rely on the record.
 *
 * Best-effort: this runs from a gateway event with nobody waiting on it, so
 * a cache failure is logged and never thrown.
 */
export async function forgetConnectionOnLeave(
  member: GuildMember | PartialGuildMember,
): Promise<void> {
  if (member.guild.id !== GUILD_ID || member.user.bot) {
    return;
  }
  try {
    await forgetMeetupTokens(await ApplicationCache(), member.id);
    logger.info(
      `Cleared any saved Meetup connection for departed Discord user ${member.id}`,
    );
  } catch (error: unknown) {
    logger.error(
      `Could not clear the saved Meetup connection for departed Discord user ` +
        `${member.id}: ${error instanceof Error ? error.name : 'unknown error'}`,
    );
  }
}

/**
 * `guildMemberRemove` fires for a leave, a kick and a ban alike.
 *
 * This is NOT the identity monitoring listeners coming back. Those were
 * removed on purpose in favour of the daily sweep; this one records nothing
 * about anyone and exists only to discard a credential.
 */
export function registerMemberLeaveListener(client: Client): void {
  client.on('guildMemberRemove', (member) => {
    void forgetConnectionOnLeave(member);
  });
}

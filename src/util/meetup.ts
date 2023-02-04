import { CommandInteraction } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import {
  BASIC_MEETUP_AUTH_SCOPES,
  DISCORD_BOT_MEETUP_OAUTH_OVERRIDE_URL,
} from '../constants';
import { InMemoryCache } from '../lib/cache/memoryCache';
import { GqlMeetupClient } from '../lib/client/meetup/gqlClient';
import { spinWait } from './spinWait';

async function showMeetupTokenUrl(interaction: CommandInteraction) {
  const maskedUserId = uuidv4();
  await InMemoryCache.instance().set(
    `maskedUserId-${maskedUserId}`,
    interaction.user.id
  );
  await interaction.editReply({
    content: `Please click on this link to get your Meetup Auth token: ${DISCORD_BOT_MEETUP_OAUTH_OVERRIDE_URL(
      maskedUserId,
      BASIC_MEETUP_AUTH_SCOPES
    )}`,
  });
}

/**
 * A wrapper for Meetup commands to handle:
 * 1. Authentication
 * 2. Grabbing token
 * @param commandFn Lambda for command implementation
 */
export async function withMeetupClient(
  interaction: CommandInteraction,
  commandFn: (meetupClient: GqlMeetupClient) => Promise<void>
) {
  const tokenKey = `userId-${interaction.user.id}`;
  let token = await InMemoryCache.instance().get(tokenKey);
  if (!token) {
    await showMeetupTokenUrl(interaction);
    token = await spinWait(() => InMemoryCache.instance().get(tokenKey), {
      timeoutMs: 60 * 1000,
      message: 'Timeout waiting for Meetup authentication. Please try again',
      intervalMs: 1000,
    });
  }
  const client = new GqlMeetupClient(token);
  await commandFn(client);
}

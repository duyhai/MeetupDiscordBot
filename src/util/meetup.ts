import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  CommandInteraction,
  MessageActionRowComponentBuilder,
  ModalSubmitInteraction,
} from 'discord.js';
import { Logger } from 'tslog';
import { generateOAuthUrl } from '../constants.js';
import { createOAuthState } from '../lib/client/oauth/state.js';
import { Tokens } from '../lib/client/discord/types.js';
import { GqlMeetupClient } from '../lib/client/meetup/gqlClient.js';
import { replyStack } from '../lib/messageStack/registry.js';
import { EntryId } from '../lib/messageStack/types.js';
import { ApplicationCache } from './cache.js';
import { spinWait } from './spinWait.js';

const logger = new Logger({ name: 'MeetupUtil' });

const OAUTH_HOP_TIMEOUT_MS = 3 * 60 * 1000;

async function showMeetupTokenUrl(
  interaction: ButtonInteraction | CommandInteraction | ModalSubmitInteraction,
): Promise<EntryId> {
  const maskedUserId = await createOAuthState(interaction.user.id);
  // Never log the state itself: it is a bearer credential for this flow.
  logger.info(`Issued OAuth state for ${interaction.user.username}`);

  const oauthUrl = generateOAuthUrl('meetup', { state: maskedUserId });

  const button = new ButtonBuilder()
    .setLabel('Connect to Meetup')
    .setEmoji('🧲')
    .setStyle(ButtonStyle.Link)
    .setURL(oauthUrl);

  const row =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      button,
    );

  return replyStack(interaction).ephemeral.append({
    content: 'Please connect your Meetup account:',
    components: [row],
    status: 'pending',
  });
}

/**
 * A wrapper for Meetup commands to handle:
 * 1. Authentication
 * 2. Grabbing token
 * @param commandFn Lambda for command implementation
 */
export async function withMeetupClient(
  interaction: ButtonInteraction | CommandInteraction | ModalSubmitInteraction,
  commandFn: (meetupClient: GqlMeetupClient) => Promise<void>,
) {
  const tokenKey = `${interaction.user.id}-meetup-tokens`;
  const cache = await ApplicationCache();
  let rawTokens = await cache.get(tokenKey);
  if (!rawTokens) {
    logger.info(
      `Tokens are not present for ${interaction.user.username} at ${tokenKey}. Getting token through OAuth`,
    );
    const progressId = await showMeetupTokenUrl(interaction);
    rawTokens = await spinWait(() => cache.get(tokenKey), {
      // Matches the V2 hop budget: the iOS hand-off to Safari can require a
      // sign-in before consent, and the interaction token lasts ~15 minutes.
      timeoutMs: OAUTH_HOP_TIMEOUT_MS,
      message: 'Timeout waiting for Meetup authentication. Please try again',
      intervalMs: 1000,
    });
    // The connect-your-account prompt stays pending and visible for the
    // whole spinWait; once the tokens land the account is connected, so
    // drop it rather than let it drag the final banner to pending.
    replyStack(interaction).ephemeral.remove(progressId);
  }
  const tokens = JSON.parse(rawTokens) as Tokens;
  const client = new GqlMeetupClient(tokens.accessToken);
  await commandFn(client);
}

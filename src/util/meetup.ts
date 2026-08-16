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
import { ApplicationCache } from './cache.js';
import { waitForMeetupTokens } from '../lib/helpers/oauthWait.js';
import { keepReplyVisible } from './discord.js';

const logger = new Logger({ name: 'MeetupUtil' });

const OAUTH_HOP_TIMEOUT_MS = 3 * 60 * 1000;

const strings = {
  notFinishedButton:
    "You haven't finished connecting your Meetup account yet. Once you've " +
    'authorized, press **Try again** below and it will pick up right where ' +
    'you left off.',
  notFinishedCommand:
    "You haven't finished connecting your Meetup account yet. Once you've " +
    'authorized, run the command again and it will pick up right where you ' +
    'left off.',
};

/**
 * Tells the member how to resume, rather than treating an unfinished
 * authorization as a failure.
 *
 * For a button, the retry re-uses the custom id that got them here, so the
 * press re-enters the very same handler and no registry of retry actions has
 * to be kept in sync. A slash command has no button to re-press, so it gets
 * the equivalent instruction as text.
 */
async function showRetry(
  interaction: ButtonInteraction | CommandInteraction | ModalSubmitInteraction,
) {
  const retryRow = interaction.isButton()
    ? [
        new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          new ButtonBuilder()
            .setLabel('Try again')
            .setEmoji('🔄')
            .setStyle(ButtonStyle.Primary)
            .setCustomId(interaction.customId),
        ),
      ]
    : [];
  await interaction.editReply({
    content: interaction.isButton()
      ? strings.notFinishedButton
      : strings.notFinishedCommand,
    components: retryRow,
  });
  // discordCommandWrapper deletes the progress reply on success; this reply
  // IS the outcome, so it has to survive that cleanup.
  keepReplyVisible(interaction);
}

async function showMeetupTokenUrl(
  interaction: ButtonInteraction | CommandInteraction | ModalSubmitInteraction,
) {
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

  await interaction.editReply({
    content: 'Please connect your Meetup account:',
    components: [row],
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
    await showMeetupTokenUrl(interaction);
    // Generous window: the iOS hand-off to Safari can require a sign-in
    // before consent, and the interaction token lasts ~15 minutes.
    const waitResult = await waitForMeetupTokens(
      (key) => cache.get(key),
      tokenKey,
      { timeoutMs: OAUTH_HOP_TIMEOUT_MS, intervalMs: 1000 },
    );
    if (waitResult.status === 'pending') {
      logger.info(
        `${interaction.user.username} has not finished authorizing Meetup yet`,
      );
      await showRetry(interaction);
      return;
    }
    rawTokens = waitResult.rawTokens;
  }
  const tokens = JSON.parse(rawTokens) as Tokens;
  const client = new GqlMeetupClient(tokens.accessToken);
  await commandFn(client);
}

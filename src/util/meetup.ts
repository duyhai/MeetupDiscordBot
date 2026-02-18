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
import { v4 as uuidv4 } from 'uuid';
import { generateOAuthUrl } from '../constants';
import { Tokens } from '../lib/client/discord/types';
import { GqlMeetupClient } from '../lib/client/meetup/gqlClient';
import { ApplicationCache } from './cache';
import { spinWait } from './spinWait';

const logger = new Logger({ name: 'MeetupUtil' });

async function showMeetupTokenUrl(
  interaction: ButtonInteraction | CommandInteraction | ModalSubmitInteraction,
) {
  const maskedUserId = uuidv4();
  logger.info(
    `Setting maskedUserId=${maskedUserId} for ${interaction.user.username}`,
  );
  const cache = await ApplicationCache();
  await cache.set(`maskedUserId-${maskedUserId}`, interaction.user.id);

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
    rawTokens = await spinWait(() => cache.get(tokenKey), {
      timeoutMs: 60 * 1000,
      message: 'Timeout waiting for Meetup authentication. Please try again',
      intervalMs: 1000,
    });
  }
  const tokens = JSON.parse(rawTokens) as Tokens;
  const client = new GqlMeetupClient(tokens.accessToken);
  await commandFn(client);
}

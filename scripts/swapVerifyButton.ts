/* eslint-disable no-console */
// One-off: swaps the live Get Verified button between the V1 and V2 flows.
//   Forward:  source .env && npx tsx scripts/swapVerifyButton.ts
//   Rollback: source .env && npx tsx scripts/swapVerifyButton.ts --rollback
// Run exactly once per direction; verify in Discord afterwards.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  GatewayIntentBits,
  MessageActionRowComponentBuilder,
  TextChannel,
} from 'discord.js';

import { GET_VERIFIED_CHANNEL_ID } from '../src/constants.js';

const V1_ID = 'sync_meetup_account';
const V2_ID = 'sync_meetup_account_v2';
const BADGE_LINE =
  '\nLinking also unlocks the 1.5 profile badge on your Discord profile (member since, events attended, events hosted).';

async function main() {
  const rollback = process.argv.includes('--rollback');
  const [fromId, toId] = rollback ? [V2_ID, V1_ID] : [V1_ID, V2_ID];

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_API_KEY);

  const channel = await client.channels.fetch(GET_VERIFIED_CHANNEL_ID);
  if (!(channel instanceof TextChannel)) {
    throw new Error('get-verified channel not found or not a text channel');
  }
  const messages = await channel.messages.fetch({ limit: 50 });
  const target = messages.find(
    (message) =>
      message.author.id === client.user?.id &&
      message.components.some(
        (row) =>
          row.type === ComponentType.ActionRow &&
          row.components.some(
            (component) =>
              'customId' in component && component.customId === fromId,
          ),
      ),
  );
  if (!target) {
    throw new Error(`No bot message with a ${fromId} button found`);
  }

  const button = new ButtonBuilder()
    .setLabel('Link Meetup Account')
    .setEmoji('🔗')
    .setStyle(ButtonStyle.Danger)
    .setCustomId(toId);
  const row =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      button,
    );

  const baseContent = target.content.replace(BADGE_LINE, '');
  const content = rollback ? baseContent : `${baseContent}${BADGE_LINE}`;

  await target.edit({ content, components: [row] });
  console.log(
    `Swapped button ${fromId} -> ${toId} on message ${target.id} in #${channel.name}`,
  );
  await client.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

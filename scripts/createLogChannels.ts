/* eslint-disable no-console */
// One-off script: creates the two Meetup-bot log channels and prints their
// IDs so they can be hardcoded in src/constants.ts. Run once:
//   source .env && npx tsx scripts/createLogChannels.ts
import { ChannelType, Client, GatewayIntentBits } from 'discord.js';

const LOGS_CATEGORY_ID = '932896530447364146'; // 📜Logs
const LEADERSHIP_CATEGORY_ID = '912463487257686066'; // 🏢1.5 Leadership Team

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_API_KEY);

  const guilds = await client.guilds.fetch();
  const guildId = guilds.first()?.id;
  if (!guildId) {
    throw new Error('Bot is not in any guild');
  }
  const guild = await client.guilds.fetch(guildId);
  console.log(`Creating log channels in guild: ${guild.name}`);

  const activity = await guild.channels.create({
    name: '🟥🤖meetup-bot-activity',
    type: ChannelType.GuildText,
    parent: LOGS_CATEGORY_ID,
    reason: 'Meetup bot activity log (created by createLogChannels script)',
  });
  const alerts = await guild.channels.create({
    name: '🟥🚨meetup-bot-alerts',
    type: ChannelType.GuildText,
    parent: LEADERSHIP_CATEGORY_ID,
    reason: 'Meetup bot alerts log (created by createLogChannels script)',
  });

  console.log(`BOT_ACTIVITY_LOG_CHANNEL_ID = '${activity.id}'`);
  console.log(`BOT_ALERTS_CHANNEL_ID = '${alerts.id}'`);

  await client.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

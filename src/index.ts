import { APIUser, GatewayIntentBits, Interaction, Message } from 'discord.js';
import { Client } from 'discordx';
import express, { RequestHandler } from 'express';
import session from 'express-session';
import grant, { GrantSession } from 'grant';
import { Logger } from 'tslog';

import Configuration from './configuration';
import './buttonMenu';
import './contextMenu';
import './commands';
import { generateOAuthUrl } from './constants';
import { APIAccessTokenResponse, Tokens } from './lib/client/discord/types';
import { ApplicationCache } from './util/cache';

const logger = new Logger({ name: 'MeetupBot' });

/// ////////////////////////////////////////////////////////////////
//                         EXPRESS SERVER                         //
/// ////////////////////////////////////////////////////////////////

const PORT = process.env.PORT || 5000;

const app = express();

app.use(express.urlencoded({ extended: true }));

app
  .use(session({ secret: 'grant', saveUninitialized: true, resave: false }))
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  .use(grant.express(Configuration.grant));

app.get('/connect/meetup/callback', (async (req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
  const grantSession = (req.session as any).grant as GrantSession;
  logger.info(`Meetup response: ${JSON.stringify(grantSession)}`);
  if (grantSession.response.error) {
    res.end(JSON.stringify(grantSession.response.error));
    return;
  }
  const rawTokens = grantSession.response.raw as APIAccessTokenResponse;
  const tokens: Tokens = {
    accessToken: rawTokens.access_token,
    refreshToken: rawTokens.refresh_token,
    expiresAt: Date.now() + rawTokens.expires_in * 1000,
  };
  const cache = await ApplicationCache();
  try {
    const userId = await cache.get(`maskedUserId-${grantSession.state}`);
    await cache.set(`${userId}-meetup-tokens`, JSON.stringify(tokens));
    res.end(`Connected to Meetup. You can close this window now!`);
  } catch (err) {
    res.end(`Failed to data store! Please try again.`);
  }
}) as RequestHandler);

// TODO: Refactor into helper
app.get('/connect/discord/callback', (async (req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
  const grantSession = (req.session as any).grant as GrantSession;
  logger.info(`Discord response: ${JSON.stringify(grantSession)}`);
  if (grantSession.response.error) {
    res.end(JSON.stringify(grantSession.response.error));
    return;
  }
  const rawTokens = grantSession.response.raw as APIAccessTokenResponse;
  const tokens: Tokens = {
    accessToken: rawTokens.access_token,
    refreshToken: rawTokens.refresh_token,
    expiresAt: Date.now() + rawTokens.expires_in * 1000,
  };
  const profile = grantSession.response.profile as APIUser;
  logger.info(JSON.stringify(profile));
  const cache = await ApplicationCache();
  await cache.set(`maskedUserId-${grantSession.state}`, profile.id);
  await cache.set(`${profile.id}-discord-tokens`, JSON.stringify(tokens));
  res.redirect(307, generateOAuthUrl('meetup', { state: grantSession.state }));
}) as RequestHandler);

app.get('/discord-meetup-connect', (_req, res) => {
  res.redirect(307, generateOAuthUrl('discord'));
});

app.get('/redirect/:url', (req, res) => {
  const { url } = req.params;
  if (url) {
    const decodedUrl = Buffer.from(url, 'base64').toString('utf-8');
    const redirectUrl = new URL(decodedUrl);
    if (req.query) {
      Object.entries(req.query).forEach(([key, value]) => {
        redirectUrl.searchParams.append(key, value.toString());
      });
    }
    logger.info(`Redirecting to ${redirectUrl.toString()}`);
    return res.redirect(307, redirectUrl.toString());
  }
  return res.send('Invalid url');
});

/// ////////////////////////////////////////////////////////////////
//                          DISCORD CLIENT                       //
/// ////////////////////////////////////////////////////////////////

const client = new Client({
  simpleCommand: {
    prefix: '!',
  },
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ],
  // If you only want to use global commands only, comment this line
  botGuilds: [(botClient) => botClient.guilds.cache.map((guild) => guild.id)],
});

client.once('ready', async () => {
  // make sure all guilds are in cache
  await client.guilds.fetch();

  // init all application commands
  await client.initApplicationCommands();

  logger.info('Bot started');
});

client.on('interactionCreate', async (interaction: Interaction) => {
  await client.executeInteraction(interaction);
});

client.on('messageCreate', async (message: Message) => {
  await client.executeCommand(message);
});

async function run() {
  const token = Configuration.discord.apiKey;
  await client.login(token);
}

/// ////////////////////////////////////////////////////////////////
//                             RUN STUFF                         //
/// ////////////////////////////////////////////////////////////////

run().catch((error) => logger.error(JSON.stringify(error)));
app.listen(PORT, () => logger.info(`Server started on port ${PORT}!`));

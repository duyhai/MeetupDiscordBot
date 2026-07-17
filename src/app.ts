import { APIUser } from 'discord.js';
import express, { RequestHandler } from 'express';
import session from 'express-session';
import * as grantModule from 'grant';
import {
  ExpressMiddleware,
  GrantConfig,
  GrantInstance,
  GrantOptions,
  GrantSession,
} from 'grant';
import { Logger } from 'tslog';

import Configuration from './configuration.js';
import { generateOAuthUrl } from './constants.js';
import { APIAccessTokenResponse, Tokens } from './lib/client/discord/types.js';
import { getAuthLandingPage } from './templates/authLanding.js';
import { ApplicationCache } from './util/cache.js';

// grant ships an ESM-style .d.ts over a CJS module, so under nodenext
// (tsx/tsc) `.default` is typed as the whole namespace rather than the grant
// function itself. At runtime `.default` is module.exports (grant sets
// `grant.default = grant`), so cast it once to its real shape.
const grant = grantModule.default as unknown as {
  express(
    config: GrantConfig | GrantOptions,
  ): ExpressMiddleware & GrantInstance;
};

const logger = new Logger({ name: 'MeetupBot' });

const app = express();

app.use(express.urlencoded({ extended: true }));

app
  .use(session({ secret: 'grant', saveUninitialized: true, resave: false }))
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  .use(grant.express(Configuration.grant));

// Named and exported (rather than inline) so integration tests can mount
// them directly on a minimal test app, without going through grant's own
// `/connect/:provider/callback` middleware, which needs live OAuth
// credentials to consider a provider "configured".
export const meetupConnectCallbackHandler: RequestHandler = (async (
  req,
  res,
) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
  const grantSession = (req.session as any).grant as GrantSession;
  logger.info(`Meetup response: ${JSON.stringify(grantSession)}`);
  if (grantSession.response.error) {
    res.send(
      getAuthLandingPage('error', JSON.stringify(grantSession.response.error)),
    );
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
    res.send(
      getAuthLandingPage(
        'success',
        'Connected to Meetup. You can close this window now!',
      ),
    );
  } catch (_err) {
    res.send(
      getAuthLandingPage('error', 'Failed to data store! Please try again.'),
    );
  }
}) as RequestHandler;

// TODO: Refactor into helper
export const discordConnectCallbackHandler: RequestHandler = (async (
  req,
  res,
) => {
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
}) as RequestHandler;

app.get('/connect/meetup/callback', meetupConnectCallbackHandler);
app.get('/connect/discord/callback', discordConnectCallbackHandler);

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

export default app;

import express, { ErrorRequestHandler, RequestHandler } from 'express';
import { Logger } from 'tslog';

import {
  buildDiscordAuthUrl,
  buildMeetupAuthUrl,
  exchangeDiscordCode,
  exchangeMeetupCode,
  fetchDiscordUserId,
} from './lib/client/oauth/providers.js';
import { resolveOAuthState } from './lib/client/oauth/state.js';
import { getAuthLandingPage } from './templates/authLanding.js';
import { ApplicationCache } from './util/cache.js';

const logger = new Logger({ name: 'MeetupBot' });

const app = express();

app.use(express.urlencoded({ extended: true }));

const strings = {
  expiredState:
    'This link expired or was already used. Please go back to Discord and press the button again.',
  accountMismatch:
    'This link belongs to a different Discord account. Please press the button yourself and use the link it gives you.',
  providerDenied:
    'The authorization was cancelled or denied. Please go back to Discord and try again.',
  exchangeFailed:
    'Could not complete the connection. Please go back to Discord and try again.',
  meetupSuccess: 'Connected to Meetup. Heading back to Discord…',
  unexpected:
    'Something went wrong on our end. Please go back to Discord and try again in a moment.',
};

const errorPage = (
  res: Parameters<RequestHandler>[1],
  status: number,
  message: string,
) => res.status(status).send(getAuthLandingPage('error', message));

export const discordConnectHandler: RequestHandler = (async (req, res) => {
  const state = String(req.query.state ?? '');
  if (!(await resolveOAuthState(state))) {
    return errorPage(res, 400, strings.expiredState);
  }
  return res.redirect(302, buildDiscordAuthUrl(state));
}) as RequestHandler;

export const meetupConnectHandler: RequestHandler = (async (req, res) => {
  const state = String(req.query.state ?? '');
  if (!(await resolveOAuthState(state))) {
    return errorPage(res, 400, strings.expiredState);
  }
  return res.redirect(302, buildMeetupAuthUrl(state));
}) as RequestHandler;

export const discordConnectCallbackHandler: RequestHandler = (async (
  req,
  res,
) => {
  const state = String(req.query.state ?? '');
  const userId = await resolveOAuthState(state);
  if (!userId) {
    return errorPage(res, 400, strings.expiredState);
  }
  if (req.query.error || !req.query.code) {
    logger.warn(`Discord authorize denied: ${JSON.stringify(req.query)}`);
    return res
      .status(200)
      .send(getAuthLandingPage('error', strings.providerDenied));
  }
  try {
    const tokens = await exchangeDiscordCode(String(req.query.code));
    const profileId = await fetchDiscordUserId(tokens.accessToken);
    if (profileId !== userId) {
      logger.warn(
        `OAuth state/account mismatch: state belongs to ${userId}, token belongs to ${profileId}`,
      );
      return errorPage(res, 400, strings.accountMismatch);
    }
    const cache = await ApplicationCache();
    await cache.set(`${userId}-discord-tokens`, JSON.stringify(tokens));
    return res.redirect(307, `/connect/meetup?state=${state}`);
  } catch (error) {
    logger.error(`Discord token exchange failed: ${String(error)}`);
    return errorPage(res, 502, strings.exchangeFailed);
  }
}) as RequestHandler;

export const meetupConnectCallbackHandler: RequestHandler = (async (
  req,
  res,
) => {
  const state = String(req.query.state ?? '');
  const userId = await resolveOAuthState(state);
  if (!userId) {
    return errorPage(res, 400, strings.expiredState);
  }
  if (req.query.error || !req.query.code) {
    logger.warn(`Meetup authorize denied: ${JSON.stringify(req.query)}`);
    return res
      .status(200)
      .send(getAuthLandingPage('error', strings.providerDenied));
  }
  try {
    const tokens = await exchangeMeetupCode(String(req.query.code));
    const cache = await ApplicationCache();
    await cache.set(`${userId}-meetup-tokens`, JSON.stringify(tokens));
    return res.send(getAuthLandingPage('success', strings.meetupSuccess));
  } catch (error) {
    logger.error(`Meetup token exchange failed: ${String(error)}`);
    return errorPage(res, 502, strings.exchangeFailed);
  }
}) as RequestHandler;

app.get('/connect/discord', discordConnectHandler);
app.get('/connect/discord/callback', discordConnectCallbackHandler);
app.get('/connect/meetup', meetupConnectHandler);
app.get('/connect/meetup/callback', meetupConnectCallbackHandler);

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

// Express 5 forwards rejected async handler promises here. Anything that
// escapes a handler (e.g. the cache being unreachable) must still land the
// user on the branded page with a way back to Discord, never on Express's
// stack-trace page.
app.use(((error, _req, res, _next) => {
  logger.error(`Unhandled OAuth route error: ${String(error)}`);
  res.status(500).send(getAuthLandingPage('error', strings.unexpected));
}) as ErrorRequestHandler);

export default app;

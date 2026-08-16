import { Client } from 'discord.js';
import express, { ErrorRequestHandler, RequestHandler } from 'express';
import { Logger } from 'tslog';

import { logActivity, logAlert } from './lib/helpers/discordLogger.js';
import {
  buildMeetupAuthUrl,
  exchangeMeetupCode,
} from './lib/client/oauth/providers.js';
import {
  consumeOAuthState,
  resolveOAuthState,
} from './lib/client/oauth/state.js';
import { getAuthLandingPage } from './templates/authLanding.js';
import { ApplicationCache } from './util/cache.js';

const logger = new Logger({ name: 'MeetupBot' });

const app = express();

const strings = {
  expiredState:
    'This link expired or was already used. Please go back to Discord and press the button again.',
  providerDenied:
    'The authorization was cancelled or denied. Please go back to Discord and try again.',
  exchangeFailed:
    'Could not complete the connection. Please go back to Discord and try again.',
  meetupSuccess: 'Connected to Meetup. Heading back to Discord…',
  unexpected:
    'Something went wrong on our end. Please go back to Discord and try again in a moment.',
  notFound:
    'There is nothing at this address. Head back to Discord and press the button again.',
};

const errorPage = (
  res: Parameters<RequestHandler>[1],
  status: number,
  message: string,
) => res.status(status).send(getAuthLandingPage('error', message));

// The express app boots before the Discord client logs in, so index.ts hands
// the client over on ready. Until then (and in unit tests) OAuth reporting is
// a no-op rather than a crash.
let alertClient: Client | undefined;

export function setOAuthAlertClient(client: Client | undefined) {
  alertClient = client;
}

interface OAuthReport {
  description: string;
  title: string;
}

/**
 * Genuine faults in the OAuth chain: the member is stuck and somebody should
 * look. These are invisible otherwise -- the callbacks run outside
 * discordCommandWrapper, so nothing else reports them.
 */
async function reportOAuthFault({ description, title }: OAuthReport) {
  if (!alertClient) {
    return;
  }
  await logAlert(alertClient, {
    title: `Meetup OAuth: ${title}`,
    description,
  });
}

/**
 * Expected, self-healing outcomes -- a stale link re-clicked, a crawler
 * hitting a public route. Recorded, but never worth interrupting anyone.
 */
async function reportOAuthNotice({ description, title }: OAuthReport) {
  if (!alertClient) {
    return;
  }
  await logActivity(alertClient, {
    title: `Meetup OAuth: ${title}`,
    description,
  });
}

export const meetupConnectHandler: RequestHandler = (async (req, res) => {
  const state = String(req.query.state ?? '');
  const record = await resolveOAuthState(state);
  if (!record) {
    await reportOAuthNotice({
      title: 'expired or unknown link',
      description: 'Someone opened a start link whose state is no longer live.',
    });
    return errorPage(res, 400, strings.expiredState);
  }
  return res.redirect(302, buildMeetupAuthUrl(state));
}) as RequestHandler;

export const meetupConnectCallbackHandler: RequestHandler = (async (
  req,
  res,
) => {
  const state = String(req.query.state ?? '');
  const record = await resolveOAuthState(state);
  if (!record) {
    await reportOAuthNotice({
      title: 'expired or unknown link',
      description: 'A callback arrived for a state that is no longer live.',
    });
    return errorPage(res, 400, strings.expiredState);
  }
  const userId = record.discordUserId;
  if (req.query.error || !req.query.code) {
    logger.warn(`Meetup authorize denied: ${String(req.query.error)}`);
    await consumeOAuthState(state);
    await reportOAuthFault({
      title: 'authorization denied',
      description: `<@${userId}> did not complete the Meetup authorization (${String(
        req.query.error || 'no code returned',
      )}).`,
    });
    return errorPage(res, 400, strings.providerDenied);
  }
  try {
    const tokens = await exchangeMeetupCode(String(req.query.code));
    const cache = await ApplicationCache();
    await cache.set(`${userId}-meetup-tokens`, JSON.stringify(tokens));
    await consumeOAuthState(state);
    return res.send(getAuthLandingPage('success', strings.meetupSuccess));
  } catch (error) {
    logger.error(`Meetup token exchange failed: ${String(error)}`);
    await reportOAuthFault({
      title: 'token exchange failed',
      description: `Could not exchange the code for <@${userId}>: ${String(error)}`,
    });
    return errorPage(res, 502, strings.exchangeFailed);
  }
}) as RequestHandler;

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
    logger.info(
      `Redirecting to ${redirectUrl.origin}${redirectUrl.pathname} [query redacted]`,
    );
    return res.redirect(307, redirectUrl.toString());
  }
  return res.send('Invalid url');
});

// Any stale or mistyped bot URL should still land the user on a page that
// points back to Discord, never on Express's default 404.
app.use((_req, res) => {
  res.status(404).send(getAuthLandingPage('error', strings.notFound));
});

// Express 5 forwards rejected async handler promises here. Anything that
// escapes a handler (e.g. the cache being unreachable) must still land the
// user on the branded page with a way back to Discord, never on Express's
// stack-trace page.
app.use(((error, _req, res, _next) => {
  logger.error(`Unhandled OAuth route error: ${String(error)}`);
  void reportOAuthFault({
    title: 'unhandled route error',
    description: `An OAuth route threw before it could report a specific cause: ${String(error)}`,
  });
  res.status(500).send(getAuthLandingPage('error', strings.unexpected));
}) as ErrorRequestHandler);

export default app;

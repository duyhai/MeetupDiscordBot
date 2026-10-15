import crypto from 'crypto';
import { Client } from 'discord.js';
import express from 'express';
import { Logger } from 'tslog';

import { BASE_DISCORD_BOT_URL } from '../constants.js';
import { logActivity } from '../lib/helpers/discordLogger.js';
import { ApplicationCache } from '../util/cache.js';
import { createDashboardRouter } from './dashboardRouter.js';
import {
  buildDashboardLoginUrl,
  exchangeDashboardCode,
  fetchDiscordIdentity,
} from './discordOAuth.js';
import { html } from './html.js';
import { layout } from './pages.js';
import { discordAccessCheck } from './roleGate.js';

export const MIN_SESSION_SECRET_LENGTH = 32;

const logger = new Logger({ name: 'dashboard' });

/** Why the dashboard is disabled, or undefined when it is configured. Never includes the secret. */
export function dashboardDisabledReason(
  env: Record<string, string | undefined>,
): string | undefined {
  const secret = env.DASHBOARD_SESSION_SECRET;
  if (!secret) {
    return 'DASHBOARD_SESSION_SECRET is not set';
  }
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    return `DASHBOARD_SESSION_SECRET is shorter than ${MIN_SESSION_SECRET_LENGTH} characters`;
  }
  return undefined;
}

// Express boots before Discord logs in; index.ts hands the client over on
// ready, exactly as it does for the OAuth alert client.
let discordClient: Client | undefined;

export function setDashboardClient(client: Client | undefined) {
  discordClient = client;
}

/**
 * The only Origin a dashboard POST may carry. URL#origin never has a trailing
 * slash or path, matching what browsers send; a trailing slash here would make
 * every POST fail closed.
 */
export function dashboardOrigin(baseUrl: string = BASE_DISCORD_BOT_URL) {
  return new URL(baseUrl).origin;
}

function notConfiguredRouter(): express.Router {
  const router = express.Router();
  router.use((_req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res
      .status(503)
      .set({
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'`,
      })
      .type('html')
      .send(
        layout({
          title: 'Not available',
          nonce,
          body: html`<div class="card">
            <p>The staff dashboard is not set up yet.</p>
          </div>`,
        }),
      );
  });
  return router;
}

export function dashboardRouterFromEnv(
  env: Record<string, string | undefined> = process.env,
): express.Router {
  const reason = dashboardDisabledReason(env);
  const secret = env.DASHBOARD_SESSION_SECRET;
  if (reason || !secret) {
    logger.warn(`Staff dashboard disabled: ${reason}`);
    return notConfiguredRouter();
  }
  return createDashboardRouter({
    cache: ApplicationCache,
    checkAccess: discordAccessCheck(() => discordClient),
    oauth: {
      buildLoginUrl: buildDashboardLoginUrl,
      exchangeCode: exchangeDashboardCode,
      fetchIdentity: fetchDiscordIdentity,
    },
    sessionSecret: secret,
    origin: dashboardOrigin(),
    audit: async (entry) => {
      if (!discordClient) {
        return false;
      }
      return logActivity(discordClient, entry);
    },
  });
}

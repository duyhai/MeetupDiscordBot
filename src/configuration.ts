import { OAuth2Scopes } from 'discord.js';
import { GrantConfig } from 'grant';
import {
  BASIC_MEETUP_AUTH_SCOPES,
  BASE_DISCORD_BOT_URL,
  debugRedirect,
} from './constants';

interface ConfigurationSchema {
  discord: {
    apiKey: string;
    oauthClientId: string;
    oauthSecret: string;
  };
  grant: GrantConfig;
  meetup: {
    apiKey: string;
    apiSecret: string;
    endpoint: string;
    groupId: string;
    groupUrlName: string;
  };
}

const Configuration: ConfigurationSchema = {
  discord: {
    apiKey: process.env.DISCORD_API_KEY,
    oauthClientId: process.env.DISCORD_CLIENT_ID,
    oauthSecret: process.env.DISCORD_SECRET,
  },
  meetup: {
    apiKey: process.env.MEETUP_KEY,
    apiSecret: process.env.MEETUP_SECRET,
    endpoint: 'https://api.meetup.com/gql',
    groupId: '7595882',
    groupUrlName: '1-5genasians',
  },
  grant: {
    defaults: {
      state: true,
      // Need to have tokens (not just raw) in order to get profile
      response: ['raw', 'profile', 'tokens'],
      transport: 'session',
    },
    // connect/discord => authorize => access => callback => connect/meetup
    discord: {
      key: process.env.DISCORD_CLIENT_ID,
      secret: process.env.DISCORD_SECRET,
      scope: [OAuth2Scopes.RoleConnectionsWrite, OAuth2Scopes.Identify],
      redirect_uri: debugRedirect(
        `${BASE_DISCORD_BOT_URL}/connect/discord/callback`
      ),
    },
    // connect/meetup => authorize => access => callback => persistToken
    meetup: {
      key: process.env.MEETUP_KEY,
      secret: process.env.MEETUP_SECRET,
      scope: BASIC_MEETUP_AUTH_SCOPES,
      // We also use it as a key for the initiator's Discord id in our memory store.
      dynamic: ['state'],
      redirect_uri: debugRedirect(
        `${BASE_DISCORD_BOT_URL}/connect/meetup/callback`
      ),
    },
  },
};

export default Configuration;

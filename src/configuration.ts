import { GrantConfig } from 'grant';
import { generateOAuthUrl } from './constants';

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
    defaults: { state: true },
    // connect/discord => authorize => access => callback => persistToken => connect/meetup
    discord: {
      key: process.env.DISCORD_CLIENT_ID,
      secret: process.env.DISCORD_SECRET,
      // This gets overridden by the callback param to persistToken
      callback: '/showToken',
      redirect_uri: `${generateOAuthUrl({
        name: 'discord',
      })}/callback`,
      response: ['tokens'],
      dynamic: ['callback', 'scope'],
    },
    // connect/meetup => authorize => access => callback => persistToken
    meetup: {
      key: process.env.MEETUP_KEY,
      secret: process.env.MEETUP_SECRET,
      // This gets overridden by the callback param to persistToken
      callback: '/showToken',
      // It's confusing, but the redirect url has "callback" in its path
      redirect_uri: `${generateOAuthUrl({
        name: 'meetup',
      })}/callback`,
      response: ['tokens'],
      dynamic: ['callback', 'scope'],
    },
  },
};

export default Configuration;

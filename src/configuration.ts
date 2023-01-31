import { GrantConfig } from 'grant';
import { DISCORD_BOT_MEETUP_OAUTH_URL } from './constants';

interface ConfigurationSchema {
  discord: {
    apiKey: string;
  };
  grant: GrantConfig;
  meetup: {
    apiKey: string;
    apiSecret: string;
    endpoint: string;
    groupId: string;
  };
}

const Configuration: ConfigurationSchema = {
  discord: {
    apiKey: process.env.DISCORD_API_KEY,
  },
  meetup: {
    apiKey: process.env.MEETUP_KEY,
    apiSecret: process.env.MEETUP_SECRET,
    endpoint: 'https://api.meetup.com/gql',
    groupId: '7595882',
  },
  grant: {
    meetup: {
      key: process.env.MEETUP_KEY,
      secret: process.env.MEETUP_SECRET,
      callback: '/showToken',
      // It's confusing, but the redirect url has "callback" in its path
      redirect_uri: `${DISCORD_BOT_MEETUP_OAUTH_URL}/callback`,
      response: ['tokens'],
      dynamic: ['callback', 'scope'],
    },
  },
};

export default Configuration;

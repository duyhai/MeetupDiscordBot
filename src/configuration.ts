import { GrantConfig } from 'grant';

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

export const DISCORD_BOT_URL = 'https://meetup-discord-bot.fly.dev';
export const DISCORD_BOT_MEETUP_OAUTH_URL = `${DISCORD_BOT_URL}/connect/meetup`;

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
      redirect_uri: `${DISCORD_BOT_MEETUP_OAUTH_URL}/callback`,
      response: ['tokens'],
      dynamic: ['callback'],
    },
  },
};

export default Configuration;

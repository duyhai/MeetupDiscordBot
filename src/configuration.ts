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
  },
  grant: {
    meetup: {
      key: process.env.MEETUP_KEY,
      secret: process.env.MEETUP_SECRET,
      callback: '/showToken',
      redirect_uri:
        'https://meetup-discord-bot.herokuapp.com/connect/meetup/callback',
      response: ['tokens'],
    },
  },
};

export default Configuration;

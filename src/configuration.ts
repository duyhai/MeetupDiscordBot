interface ConfigurationSchema {
  discord: {
    apiKey: string;
    oauthClientId: string;
    oauthSecret: string;
  };
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
    endpoint: 'https://api.meetup.com/gql-ext',
    groupId: '7595882',
    groupUrlName: '1-5genasians',
  },
};

export default Configuration;

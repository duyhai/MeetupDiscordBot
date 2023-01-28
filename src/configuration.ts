const Configuration = {
  discord: {
    apiKey: process.env.DISCORD_API_KEY,
  },
  meetup: {
    apiKey: process.env.MEETUP_KEY,
    apiSecret: process.env.MEETUP_SECRET,
  },
  grant: {
    meetup: {
      key: process.env.MEETUP_KEY,
      secret: process.env.MEETUP_SECRET,
      callback: '/persistConnection',
      redirect_uri:
        'https://meetup-discord-bot.herokuapp.com/connect/meetup/callback',
      scope: 'basic group_join',
      response: ['tokens', 'profile'],
    },
  },
};

export default Configuration;

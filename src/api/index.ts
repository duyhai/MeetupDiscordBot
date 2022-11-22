import ClientOAuth2 from 'client-oauth2';
import { Request, Response } from 'express';
import Configuration from '../configuration';

const meetupAuth = new ClientOAuth2({
  clientId: Configuration.meetupAPIKey,
  clientSecret: Configuration.meetupAPISecret,
  accessTokenUri: 'https://secure.meetup.com/oauth2/access',
  authorizationUri: 'https://secure.meetup.com/oauth2/authorize',
  redirectUri: 'https://meetup-discord-bot.herokuapp.com/auth/callback',
  scopes: [],
});

export const auth = (_request: Request, response: Response) => {
  response.redirect(meetupAuth.code.getUri());
};

export const authCallback = (request: Request, response: Response) => {
  meetupAuth.code
    .getToken(request.originalUrl)
    .then(async (user) => {
      console.log(user);
      await user.refresh().then((updatedUser) => {
        console.log(updatedUser !== user);
        console.log(updatedUser.accessToken);
      });
      // We should store the token into a database.
      return response.send(user.accessToken);
    })
    .catch(() => {});
};

export const ok = (_request: Request, response: Response) => {
  response.sendStatus(200);
};

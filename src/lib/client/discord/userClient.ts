import { APIApplicationRoleConnection, APIUser } from 'discord.js';
import { Logger } from 'tslog';
import Configuration from '../../../configuration';
import { ApplicationCache } from '../../../util/cache';
import { APIAccessTokenResponse, Tokens } from './types';

const logger = new Logger({ name: 'DiscordUserClient' });

const API = {
  METADATA: `https://discord.com/api/v10/users/@me/applications/${Configuration.discord.oauthClientId}/role-connection`,
  OAUTH: 'https://discord.com/api/v10/oauth2/token',
  SELF: 'https://discord.com/api/v10/oauth2/@me',
};

export class DiscordUserClient {
  private tokens: Tokens;

  constructor(tokens: Tokens) {
    this.tokens = tokens;
  }

  private async makeRequest<TInput, TResponse>(
    method: 'GET' | 'PUT' | 'POST' | 'DEL' | 'PATCH',
    url: string,
    input?: TInput,
  ): Promise<TResponse> {
    const params = {
      method,
      body: input ? JSON.stringify(input) : undefined,
      headers: {
        Authorization: `Bearer ${this.tokens.accessToken}`,
        ...(input ? { 'Content-Type': 'application/json' } : {}),
      },
    };
    logger.info(`makeRequest - ${url} - ${JSON.stringify(params)}`);
    const response = await fetch(url, params);
    if (!response.ok) {
      const errorMsg = `Error making request to ${url}: [${response.status}] ${
        response.statusText
      } ${await response.text()}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const data = (await response.json()) as TResponse;
    return data;
  }

  public static async fromUserId(userId: string): Promise<DiscordUserClient> {
    const cache = await ApplicationCache();
    const tokensJson = await cache.get(`${userId}-discord-accessToken`);
    const client = new DiscordUserClient(JSON.parse(tokensJson) as Tokens);
    await client.refreshAccessToken();
    return client;
  }

  /**
   * The initial token request comes with both an access token and a refresh
   * token. Check if the access token has expired, and if it has, use the
   * refresh token to acquire a new, fresh access token.
   */
  public async refreshAccessToken(): Promise<void> {
    if (Date.now() > this.tokens.expiresAt) {
      const response: APIAccessTokenResponse = await this.makeRequest(
        'POST',
        API.OAUTH,
        {
          client_id: Configuration.discord.oauthClientId,
          client_secret: Configuration.discord.oauthSecret,
          grant_type: 'refresh_token',
          refresh_token: this.tokens.accessToken,
        },
      );
      this.tokens.expiresAt = Date.now() + response.expires_in * 1000;
      this.tokens.accessToken = response.access_token;
      this.tokens.refreshToken = response.refresh_token;
      const {
        user: { id: userId },
      } = await this.getUserData();

      const cache = await ApplicationCache();
      await cache.set(
        `${userId}-discord-accessToken`,
        JSON.stringify(this.tokens),
      );
    }
  }

  /**
   * Given a user based access token, fetch profile information for the current user.
   */
  async getUserData(): Promise<{ user: APIUser }> {
    return this.makeRequest('GET', API.SELF);
  }

  /**
   * Given metadata that matches the schema, push that data to Discord on behalf
   * of the current user.
   */
  async pushMetadata(metadata: APIApplicationRoleConnection): Promise<void> {
    return this.makeRequest('PUT', API.METADATA, metadata);
  }

  /**
   * Fetch the metadata currently pushed to Discord for the currently logged
   * in user, for this specific bot.
   */
  async getMetadata(): Promise<APIApplicationRoleConnection> {
    return this.makeRequest('GET', API.METADATA);
  }
}

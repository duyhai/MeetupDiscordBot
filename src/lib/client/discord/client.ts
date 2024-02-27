import {
  APIApplicationRoleConnection,
  APIApplicationRoleConnectionMetadata,
  APIUser,
} from 'discord.js';
import { Logger } from 'tslog';
import Configuration from '../../../configuration';
import { ApplicationCache } from '../../../util/cache';
import { APIAccessTokenResponse, Tokens } from './types';

const logger = new Logger({ name: 'DiscordRestClient' });

const API = {
  METADATA: `https://discord.com/api/v10/users/@me/applications/${Configuration.discord.oauthClientId}/role-connection`,
  METADATA_REGISTER: `https://discord.com/api/v10/applications/${Configuration.discord.oauthClientId}/role-connections/metadata`,
  OAUTH: 'https://discord.com/api/v10/oauth2/token',
  SELF: 'https://discord.com/api/v10/oauth2/@me',
};

export class DiscordRestClient {
  private tokens: Tokens;

  constructor(tokens: Tokens) {
    this.tokens = tokens;
  }

  private async makeRequest<TInput, TResponse>(
    method: 'GET' | 'POST' | 'DEL' | 'PATCH',
    url: string,
    input?: TInput
  ): Promise<TResponse> {
    const response = await fetch(url, {
      method,
      body: input ? JSON.stringify(input) : undefined,
      headers: {
        Authorization: `Bearer ${this.tokens.accessToken}`,
        ...(input ?? {}),
      },
    });
    if (!response.ok) {
      const errorMsg = `Error making request to ${url}: [${response.status}] ${response.statusText}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const data = (await response.json()) as TResponse;
    return data;
  }

  public static async fromUserId(userId: string): Promise<DiscordRestClient> {
    const cache = await ApplicationCache();
    const tokensJson = await cache.get(`${userId}-discord-accessToken`);
    const client = new DiscordRestClient(JSON.parse(tokensJson) as Tokens);
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
        }
      );
      this.tokens.expiresAt = Date.now() + response.expires_in * 1000;
      this.tokens.accessToken = response.access_token;
      this.tokens.refreshToken = response.refresh_token;
      const { id: userId } = await this.getUserData();

      const cache = await ApplicationCache();
      await cache.set(
        `${userId}-discord-accessToken`,
        JSON.stringify(this.tokens)
      );
    }
  }

  /**
   * Given a user based access token, fetch profile information for the current user.
   */
  async getUserData(): Promise<APIUser> {
    return this.makeRequest('GET', API.SELF);
  }

  /**
   * Given metadata that matches the schema, push that data to Discord on behalf
   * of the current user.
   */
  async pushMetadata(metadata: APIApplicationRoleConnection): Promise<void> {
    return this.makeRequest('POST', API.METADATA, metadata);
  }

  /**
   * Fetch the metadata currently pushed to Discord for the currently logged
   * in user, for this specific bot.
   */
  async getMetadata(): Promise<APIApplicationRoleConnection> {
    return this.makeRequest('GET', API.METADATA);
  }

  /**
   * Register the metadata to be stored by Discord. This should be a one time action.
   * Note: uses a Bot token for authentication, not a user token.
   */
  async registerMetadata(
    metadata: APIApplicationRoleConnectionMetadata[]
  ): Promise<void> {
    return this.makeRequest('POST', API.METADATA_REGISTER, metadata);
  }
}

import { APIApplicationRoleConnectionMetadata } from 'discord.js';
import { Logger } from 'tslog';
import Configuration from '../../../configuration';

const logger = new Logger({ name: 'DiscordBotClient' });

const API = {
  METADATA_REGISTER: `https://discord.com/api/v10/applications/${Configuration.discord.oauthClientId}/role-connections/metadata`,
};

export class DiscordBotClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async makeRequest<TInput, TResponse>(
    method: 'GET' | 'PUT' | 'POST' | 'DEL' | 'PATCH',
    url: string,
    input?: TInput
  ): Promise<TResponse> {
    const params = {
      method,
      body: input ? JSON.stringify(input) : undefined,
      headers: {
        Authorization: `Bot ${this.apiKey}`,
        ...(input ? { 'Content-Type': 'application/json' } : {}),
      },
    };
    logger.info(`makeRequest - ${url} - ${JSON.stringify(params)}`);
    const response = await fetch(url, params);
    if (!response.ok) {
      const errorMsg = `Error making request to ${url}: [${response.status}] ${response.statusText}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const data = (await response.json()) as TResponse;
    return data;
  }

  /**
   * Register the metadata to be stored by Discord. This should be a one time action.
   * Note: uses a Bot token for authentication, not a user token.
   */
  async registerMetadata(
    metadata: APIApplicationRoleConnectionMetadata[]
  ): Promise<void> {
    return this.makeRequest('PUT', API.METADATA_REGISTER, metadata);
  }
}

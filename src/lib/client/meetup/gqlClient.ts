import { GraphQLClient } from 'graphql-request';
import { Logger } from 'tslog';
import Configuration from '../../../configuration';
import { InMemoryCache } from '../../cache/memoryCache';
import {
  getPastGroupEvents,
  getUserHostedEvents,
  getUserInfo,
  getUserMembershipInfo,
} from './queries';
import {
  GetPastGroupEventsInput,
  GetPastGroupEventsResponse,
  GetUserHostedEventsInput,
  GetUserHostedEventsResponse,
  GetUserInfoResponse,
  GetUserMembershipInfoResponse,
  PaginationInput,
} from './types';

const logger = new Logger({ name: 'GqlMeetupClient' });

export class GqlMeetupClient {
  private client: GraphQLClient;

  constructor(accessToken: string) {
    this.client = new GraphQLClient(Configuration.meetup.endpoint, {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });
  }

  public async getUserInfo() {
    try {
      const result = await this.client.request<GetUserInfoResponse>(
        getUserInfo
      );
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async getUserMembershipInfo() {
    try {
      const result = await this.client.request<GetUserMembershipInfoResponse>(
        getUserMembershipInfo,
        {
          urlname: Configuration.meetup.groupUrlName,
        }
      );
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async getUserHostedEvents(input: PaginationInput) {
    try {
      const result = await this.client.request<
        GetUserHostedEventsResponse,
        GetUserHostedEventsInput
      >(getUserHostedEvents, {
        connectionInput: input,
      });
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async getPastGroupEvents(input: PaginationInput) {
    const cacheKey = `getPastGroupEvents-${JSON.stringify(input)}`;
    const data = await InMemoryCache.instance().get(cacheKey);
    if (data) {
      return JSON.parse(data) as GetPastGroupEventsResponse;
    }

    try {
      const result = await this.client.request<
        GetPastGroupEventsResponse,
        GetPastGroupEventsInput
      >(getPastGroupEvents, {
        urlname: Configuration.meetup.groupUrlName,
        connectionInput: input,
      });
      await InMemoryCache.instance().set(cacheKey, JSON.stringify(result));
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }
}

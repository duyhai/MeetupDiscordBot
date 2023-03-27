import { GraphQLClient } from 'graphql-request';
import { Logger } from 'tslog';
import Configuration from '../../../configuration';
import { cachedGqlRequest } from './cacheHelper';
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
  GetUserMembershipInfoInput,
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
    logger.info(`Calling getUserInfo with input: ${JSON.stringify({})}`);
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
    logger.info(
      `Calling getUserMembershipInfo with input: ${JSON.stringify({})}`
    );
    try {
      const result = await this.client.request<
        GetUserMembershipInfoResponse,
        GetUserMembershipInfoInput
      >(getUserMembershipInfo, {
        urlname: Configuration.meetup.groupUrlName,
      });
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async getUserHostedEvents(input: PaginationInput) {
    logger.info(
      `Calling getUserHostedEvents with input: ${JSON.stringify(input)}`
    );
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
    logger.info(
      `Calling getPastGroupEvents with input: ${JSON.stringify(input)}`
    );
    // Can be cached because it doesn't retrieve user specific data
    return cachedGqlRequest(
      'getPastGroupEvents',
      {
        urlname: Configuration.meetup.groupUrlName,
        connectionInput: input,
      },
      (callbackInput: GetPastGroupEventsInput) => {
        try {
          return this.client.request<
            GetPastGroupEventsResponse,
            GetPastGroupEventsInput
          >(getPastGroupEvents, callbackInput);
        } catch (error) {
          logger.error(error);
          throw error;
        }
      }
    );
  }
}

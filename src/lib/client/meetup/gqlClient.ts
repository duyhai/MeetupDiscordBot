import { GraphQLClient } from 'graphql-request';
import { Logger } from 'tslog';
import Configuration from '../../../configuration';
import {
  getPastEvents,
  getUserHostedEvents,
  getUserInfo,
  getUserMembershipInfo,
} from './queries';
import {
  GetPastEventsInput,
  GetPastEventsResponse,
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

  public getUserInfo() {
    return this.client
      .request<GetUserInfoResponse>(getUserInfo)
      .then((result) => result)
      .catch((error) => {
        logger.error(error);
        throw error;
      });
  }

  public getUserMembershipInfo() {
    return this.client
      .request<GetUserMembershipInfoResponse>(getUserMembershipInfo, {
        urlname: Configuration.meetup.groupUrlName,
      })
      .then((result) => result)
      .catch((error) => {
        logger.error(error);
        throw error;
      });
  }

  public getUserHostedEvents(input: PaginationInput) {
    return this.client
      .request<GetUserHostedEventsResponse, GetUserHostedEventsInput>(
        getUserHostedEvents,
        {
          connectionInput: input,
        }
      )
      .then((result) => result)
      .catch((error) => {
        logger.error(error);
        throw error;
      });
  }

  public getPastEvents(input: PaginationInput) {
    return this.client
      .request<GetPastEventsResponse, GetPastEventsInput>(getPastEvents, {
        urlname: Configuration.meetup.groupUrlName,
        connectionInput: input,
      })
      .then((result) => result)
      .catch((error) => {
        logger.error(error);
        throw error;
      });
  }
}

import { GraphQLClient } from 'graphql-request';
import { Logger } from 'tslog';
import Configuration from '../../../configuration';
import { getUserInfo } from './queries';
import { GetUserInfoResponse } from './types';

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
}

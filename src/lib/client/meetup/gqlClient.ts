import { GraphQLClient } from 'graphql-request';
import { Logger } from 'tslog';
import Configuration from '../../../configuration';
import { cachedClientRequest } from '../cacheClientHelper';
import {
  announceEvent,
  closeEventRsvps,
  createEvent,
  editEvent,
  publishEventDraft,
} from './mutations';
import {
  getEvent,
  getEventRsvps,
  getGroupEvents,
  getUserHostedEvents,
  getUserInfo,
  getUserMembershipInfo,
} from './queries';
import {
  AnnounceEventInput,
  AnnounceEventResponse,
  CloseEventRsvpsInput,
  CloseEventRsvpsResponse,
  CreateEventInput,
  CreateEventResponse,
  EditEventInput,
  EditEventResponse,
  GetEventResponse,
  GetEventRsvpsInput,
  GetEventRsvpsResponse,
  GetGroupEventsInput,
  GetGroupEventsResponse,
  GetUserHostedEventsInput,
  GetUserHostedEventsResponse,
  GetUserInfoResponse,
  GetUserMembershipInfoInput,
  GetUserMembershipInfoResponse,
  GroupEventFilter,
  PaginationInput,
  PublishEventDraftInput,
  PublishEventDraftResponse,
  RsvpFilter,
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
      logger.info(`getUserInfo result: ${JSON.stringify(result)}`);
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
      logger.info(`getUserMembershipInfo result: ${JSON.stringify(result)}`);
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
        ...input,
      });
      logger.info(`getUserHostedEvents result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async getGroupEvents(
    input: PaginationInput,
    filter?: GroupEventFilter
  ) {
    logger.info(`Calling getGroupEvents with input: ${JSON.stringify(input)}`);
    // Can be cached because it doesn't retrieve user specific data
    return cachedClientRequest(
      'getGroupEvents',
      {
        urlname: Configuration.meetup.groupUrlName,
        ...input,
        filter,
      },
      async (callbackInput: GetGroupEventsInput) => {
        try {
          const result = await this.client.request<
            GetGroupEventsResponse,
            GetGroupEventsInput
          >(getGroupEvents, callbackInput);
          // logger.info(`getGroupEvents result: ${JSON.stringify(result)}`);
          return result;
        } catch (error) {
          logger.error(error);
          throw error;
        }
      }
    );
  }

  public async getEventRsvps(
    eventId: string,
    input: PaginationInput,
    filter?: RsvpFilter
  ) {
    logger.info(`Calling getEventRsvps with input: ${JSON.stringify(input)}`);
    // Can be cached because it doesn't retrieve user specific data
    return cachedClientRequest(
      'getEventRsvps',
      {
        eventId,
        ...input,
        filter,
      },
      async (callbackInput: GetEventRsvpsInput) => {
        try {
          const result = await this.client.request<
            GetEventRsvpsResponse,
            GetEventRsvpsInput
          >(getEventRsvps, callbackInput);
          // logger.info(`getEventRsvps result: ${JSON.stringify(result)}`);
          return result;
        } catch (error) {
          logger.error(error);
          throw error;
        }
      }
    );
  }

  public async getEvent(eventId: string) {
    logger.info(`Calling getEvent with input: ${JSON.stringify({ eventId })}`);
    try {
      const result = await this.client.request<GetEventResponse>(getEvent, {
        eventId,
      });
      logger.info(`getEvent result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async createEvent(input: CreateEventInput) {
    logger.info(`Calling createEvent with input: ${JSON.stringify({ input })}`);
    try {
      const result = await this.client.request<CreateEventResponse>(
        createEvent,
        { input }
      );
      logger.info(`createEvent result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async editEvent(input: EditEventInput) {
    logger.info(`Calling editEvent with input: ${JSON.stringify({ input })}`);
    try {
      const result = await this.client.request<EditEventResponse>(editEvent, {
        input,
      });
      logger.info(`editEvent result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async closeEventRsvps(input: CloseEventRsvpsInput) {
    logger.info(
      `Calling closeEventRsvps with input: ${JSON.stringify({ input })}`
    );
    try {
      const result = await this.client.request<CloseEventRsvpsResponse>(
        closeEventRsvps,
        { input }
      );
      logger.info(`closeEventRsvps result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async publishEventDraft(input: PublishEventDraftInput) {
    logger.info(
      `Calling publishEventDraft with input: ${JSON.stringify({ input })}`
    );
    try {
      const result = await this.client.request<PublishEventDraftResponse>(
        publishEventDraft,
        { input }
      );
      logger.info(`publishEventDraft result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async announceEvent(input: AnnounceEventInput) {
    logger.info(
      `Calling announceEvent with input: ${JSON.stringify({ input })}`
    );
    try {
      const result = await this.client.request<AnnounceEventResponse>(
        announceEvent,
        { input }
      );
      logger.info(`announceEvent result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }
}

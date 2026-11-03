import { ClientError } from 'graphql-request';
import { Logger } from 'tslog';

import { CreateEventInput, CreateEventResponse } from './types.js';

export interface EventCreator {
  createEvent(input: CreateEventInput): Promise<CreateEventResponse>;
}

const logger = new Logger({ name: 'createEventWithPhotoFallback' });

/**
 * The featured photo is a fixed Meetup photo id. If that photo is ever
 * deleted, Meetup's GraphQL error names the photo; the event is then created
 * without one rather than not at all. Any other error is rethrown untouched,
 * so a failure that may already have created the event is never retried.
 */
export async function createEventWithPhotoFallback(
  meetupClient: EventCreator,
  input: CreateEventInput,
): Promise<CreateEventResponse> {
  try {
    return await meetupClient.createEvent(input);
  } catch (error: unknown) {
    const photoRejected =
      error instanceof ClientError &&
      (error.response.errors ?? []).some(({ message }) =>
        /photo/i.test(message),
      );
    if (!photoRejected) {
      throw error;
    }
    logger.warn(
      `createEvent rejected featured photo ${input.featuredPhotoId}; retrying without it`,
    );
    const withoutPhoto = { ...input };
    delete withoutPhoto.featuredPhotoId;
    return meetupClient.createEvent(withoutPhoto);
  }
}

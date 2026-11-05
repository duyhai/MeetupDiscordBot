import { ClientError } from 'graphql-request';
import { Logger } from 'tslog';

import { MeetupPayloadError } from './payloadErrors.js';
import { CreateEventInput, CreateEventResponse } from './types.js';

export interface EventCreator {
  createEvent(input: CreateEventInput): Promise<CreateEventResponse>;
}

const logger = new Logger({ name: 'createEventWithPhotoFallback' });

/**
 * The featured photo is a fixed Meetup photo id. If that photo is ever
 * deleted, Meetup's error (a GraphQL error or a payload error) names the photo; the event is then created
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
    // A payload error is thrown only when no event was created, so retrying
    // after one cannot make a second event.
    const photoRejected =
      (error instanceof ClientError &&
        (error.response.errors ?? []).some(({ message }) =>
          /photo/i.test(message),
        )) ||
      (error instanceof MeetupPayloadError &&
        error.errors.some(
          ({ field, message }) =>
            /photo/i.test(message) || /photo/i.test(field ?? ''),
        ));
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

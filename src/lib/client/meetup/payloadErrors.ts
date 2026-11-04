import { PayloadError } from './types.js';

/**
 * Meetup reports a rejected mutation (a validation error) inside the payload's
 * `errors` list with HTTP 200 and no GraphQL error, so graphql-request does
 * not throw. The client throws this instead, so a rejected write is never
 * mistaken for a success.
 */
export class MeetupPayloadError extends Error {
  public override readonly name = 'MeetupPayloadError';

  constructor(
    public readonly mutation: string,
    public readonly errors: PayloadError[],
  ) {
    super(
      `${mutation} was rejected by Meetup: ${errors
        .map(({ code, field, message }) => {
          const where = field ? ` (${field})` : '';
          return `${code}${where}: ${message}`;
        })
        .join('; ')}`,
    );
  }
}

/** Throws when a mutation payload carries errors. */
export function throwOnPayloadErrors(
  mutation: string,
  errors: PayloadError[] | null | undefined,
): void {
  if (errors && errors.length > 0) {
    throw new MeetupPayloadError(mutation, errors);
  }
}

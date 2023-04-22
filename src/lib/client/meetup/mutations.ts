import { gql } from 'graphql-request';

export const createEvent = gql`
  mutation ($input: CreateEventInput!) {
    createEvent(input: $input) {
      event {
        id
        eventUrl
      }
    }
  }
`;

export const closeEventRsvps = gql`
  mutation ($input: CloseEventRsvpsInput!) {
    closeEventRsvps(input: $input) {
      event {
        id
      }
    }
  }
`;

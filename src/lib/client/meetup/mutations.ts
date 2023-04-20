import { gql } from 'graphql-request';

export const createEvent = gql`
  mutation ($input: CreateEventInput!) {
    createEvent(input: $input) {
      eventUrl
    }
  }
`;

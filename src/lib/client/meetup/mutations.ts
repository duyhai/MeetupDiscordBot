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

export const editEvent = gql`
  mutation ($input: EditEventInput!) {
    editEvent(input: $input) {
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

export const publishEventDraft = gql`
  mutation ($input: PublishEventDraftInput!) {
    publishEventDraft(input: $input) {
      event {
        id
      }
    }
  }
`;

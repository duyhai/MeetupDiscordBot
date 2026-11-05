import { gql } from 'graphql-request';

export const createEvent = gql`
  mutation ($input: CreateEventInput!) {
    createEvent(input: $input) {
      event {
        id
        eventUrl
      }
      errors {
        code
        field
        message
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
      errors {
        code
        field
        message
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
      errors {
        code
        field
        message
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

export const announceEvent = gql`
  mutation ($input: AnnounceEventInput!) {
    announceEvent(input: $input) {
      event {
        id
      }
    }
  }
`;

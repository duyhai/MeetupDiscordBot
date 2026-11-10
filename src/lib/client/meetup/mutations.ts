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
      errors {
        code
        field
        message
      }
    }
  }
`;

/**
 * removeFromCalendar: false cancels the event (Meetup's own words: "If set
 * to false, this operation cancels the event instead of completely removing
 * it from the group's calendar"); true deletes it. The dashboard only ever
 * cancels.
 */
export const deleteEvent = gql`
  mutation ($input: DeleteEventInput!) {
    deleteEvent(input: $input) {
      success
      errors {
        code
        field
        message
      }
    }
  }
`;

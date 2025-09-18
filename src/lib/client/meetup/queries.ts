import { gql } from 'graphql-request';

export const getUserInfo = gql`
  query {
    self {
      id
      name
      gender
      memberUrl
    }
  }
`;

export const getUserMembershipInfo = gql`
  query ($urlname: String!) {
    groupByUrlname(urlname: $urlname) {
      id
      name
      isMember
      membershipMetadata {
        status
        joinTime
        rsvpStats {
          noShowCount
        }
      }
    }
  }
`;

export const getUserHostedEvents = gql`
  query ($first: Int!, $after: String) {
    self {
      id
      memberEvents(first: $first, after: $after, isHosting: true) {
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        totalCount
        edges {
          node {
            id
            dateTime
            eventUrl
            title
            group {
              id
            }
            networkEvent {
              isAnnounced
            }
          }
        }
      }
    }
  }
`;

export const getEventRsvps = gql`
  query ($eventId: ID!, $first: Int!, $after: String, $filter: RsvpFilter) {
    event(id: $eventId) {
      id
      rsvps(first: $first, after: $after, filter: $filter) {
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        yesCount
        totalCount
        edges {
          node {
            status
            member {
              id
              name
              memberUrl
            }
          }
        }
      }
    }
  }
`;

export const getGroupEvents = gql`
  query (
    $urlname: String!
    $first: Int!
    $after: String
    $filter: GroupEventFilter
  ) {
    groupByUrlname(urlname: $urlname) {
      id
      events(first: $first, after: $after, filter: $filter) {
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        totalCount
        edges {
          node {
            id
            title
            dateTime
            eventUrl
            eventHosts {
              member {
                id
                name
                memberUrl
              }
            }
            maxTickets
            status
          }
        }
      }
    }
  }
`;

export const getEvent = gql`
  query ($eventId: ID!) {
    event(id: $eventId) {
      id
      title
      description
    }
  }
`;

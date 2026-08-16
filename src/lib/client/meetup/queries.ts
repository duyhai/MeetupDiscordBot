import { gql } from 'graphql-request';

const UserFragment = gql`
  fragment UserDetails on Member {
    id
    name
    gender
    memberUrl
  }
`;

export const getUserInfo = gql`
  query {
    self {
      ...UserDetails
    }
  }
  ${UserFragment}
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

// Attendance history in one request. Verified against the live API: with
// this filter self.rsvps returns 327 for a member whose unfiltered total is
// 413, and a different groupId returns 1 -- so eventStatus/groupId genuinely
// discriminate. rsvpStatus [YES, ATTENDED] matches the per-event filter the
// group scan used, so the counts keep their existing meaning.
export const getSelfPastRsvpCount = gql`
  query ($groupId: ID!) {
    self {
      id
      rsvps(
        first: 1
        filter: {
          groupId: $groupId
          eventStatus: PAST
          rsvpStatus: [YES, ATTENDED]
        }
      ) {
        totalCount
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
              ...UserDetails
            }
          }
        }
      }
    }
  }
  ${UserFragment}
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
                ...UserDetails
              }
            }
            maxTickets
            status
          }
        }
      }
    }
  }
  ${UserFragment}
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

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

// Sends the filter exactly as given, with no +1-month expansion, so
// totalCount reflects the caller's actual window. Used where only a count is
// needed (e.g. new-host detection), unlike getGroupEvents which pads
// beforeDateTime to catch multi-day events straddling the boundary.
export const getGroupEventsCount = gql`
  query ($urlname: String!, $filter: GroupEventFilter) {
    groupByUrlname(urlname: $urlname) {
      id
      events(first: 1, filter: $filter) {
        totalCount
      }
    }
  }
`;

export const getGroupMembersByIds = gql`
  query ($urlname: String!, $memberIds: [Int!], $first: Int!) {
    groupByUrlname(urlname: $urlname) {
      id
      memberships(first: $first, filter: { memberIds: $memberIds }) {
        edges {
          node {
            ...UserDetails
          }
        }
      }
    }
  }
  ${UserFragment}
`;

// One member's RSVPs in this group, reached through the group's member list
// (there is no root query by member ID). Meetup honours groupId and the
// statuses, but not reliably startDate/endDate, so callers filter by date.
export const getMemberRsvps = gql`
  query (
    $urlname: String!
    $memberIds: [Int!]
    $first: Int!
    $after: String
    $filter: RsvpFilter
  ) {
    groupByUrlname(urlname: $urlname) {
      id
      memberships(first: 1, filter: { memberIds: $memberIds }) {
        edges {
          node {
            id
            rsvps(first: $first, after: $after, filter: $filter) {
              pageInfo {
                hasNextPage
                hasPreviousPage
                startCursor
                endCursor
              }
              totalCount
              edges {
                node {
                  event {
                    id
                    title
                    dateTime
                    eventUrl
                  }
                }
              }
            }
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

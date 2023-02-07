import { gql } from 'graphql-request';

export const getUserInfo = gql`
  query {
    self {
      id
      name
      gender
      memberships {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  }
`;

export const getPastEvents = gql`
  query ($urlname: String!, $connectionInput: ConnectionInput!) {
    groupByUrlname(urlname: $urlname) {
      id
      pastEvents(input: $connectionInput) {
        pageInfo {
          hasNextPage
          startCursor
        }
        count
        edges {
          node {
            host {
              id
              name
            }
          }
        }
      }
    }
  }
`;

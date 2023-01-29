import { gql } from 'graphql-request';

export const getUserInfo = gql`
  {
    self {
      id
      name
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

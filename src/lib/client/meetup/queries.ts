import { gql } from 'graphql-request';

export const getUserInfo = gql`
  {
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

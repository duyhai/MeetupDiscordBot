export interface GetUserInfoResponse {
  self: {
    gender: string;
    id: string;
    memberships: {
      edges: {
        node: {
          id: string;
          name: string;
        };
      }[];
    };
    name: string;
  };
}

interface PageInfo {
  endCursor: string;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string;
}

export interface GetPastEventsResponse {
  groupByUrlname: {
    id: string;
    pastEvents: {
      count: number;
      edges: {
        node: {
          dateTime: string;
          hosts: {
            id: string;
            name: string;
          }[];
        };
      }[];
      pageInfo: PageInfo;
    };
  };
}

export interface PaginationInput {
  after?: string;
  before?: string;
  first?: number;
  last?: number;
  reverse?: boolean;
}

export interface GetPastEventsInput {
  connectionInput: PaginationInput;
  urlname: string;
}

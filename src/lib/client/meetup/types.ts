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

export interface GetPastEventsResponse {
  groupByUrlname: {
    id: string;
    pastEvents: {
      count: number;
      edges: {
        node: {
          host: {
            id: string;
            name: string;
          };
        };
      }[];
      pageInfo: {
        endCursor: string;
        hasNextPage: boolean;
        hasPreviousPage: boolean;
        startCursor: string;
      };
    };
  };
}

export interface GetPastEventsRequest {
  connectionInput: {
    after?: string;
    before?: string;
    first?: number;
    last?: number;
    reverse?: boolean;
  };
  urlname: string;
}

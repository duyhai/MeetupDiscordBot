export interface PaginationInput {
  after?: string;
  before?: string;
  first?: number;
  last?: number;
  reverse?: boolean;
}

interface PageInfo {
  endCursor: string;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string;
}

export interface PaginatedData<TData> {
  count: number;
  edges: {
    node: TData;
  }[];
  pageInfo: PageInfo;
}

interface UserInfo {
  id: string;
  name: string;
}

export interface GetUserInfoResponse {
  self: {
    gender: string;
    id: string;
    name: string;
  };
}

export interface GetUserMembershipInfoResponse {
  self: {
    memberships: PaginatedData<UserInfo>;
  };
}

interface PastEvent {
  dateTime: string;
  hosts: {
    id: string;
    name: string;
  }[];
}

export interface GetPastEventsResponse {
  groupByUrlname: {
    id: string;
    pastEvents: PaginatedData<PastEvent>;
  };
}

export interface GetPastEventsInput {
  connectionInput: PaginationInput;
  urlname: string;
}

interface BaseUserInfo {
  id: string;
  name: string;
}

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

export interface GetUserInfoResponse {
  self: {
    gender: string;
  } & BaseUserInfo;
}

export interface GetUserMembershipInfoResponse {
  groupByUrlname: {
    id: string;
    isMember: boolean;
    isOrganizer: boolean;
    name: string;
  };
}

export interface GetUserMembershipInfoInput {
  urlname: string;
}

interface PastEvent {
  dateTime: string;
  going: number;
  hosts: BaseUserInfo[];
  maxTickets: number;
  tickets: PaginatedData<Ticket>;
  title: string;
}

interface EventGroupInfo {
  group: { id: string };
  title: string;
}

export interface GetUserHostedEventsResponse {
  self: {
    hostedEvents: PaginatedData<EventGroupInfo>;
    id: string;
  };
}

export interface GetUserHostedEventsInput {
  connectionInput: PaginationInput;
}

interface Ticket {
  status: number;
  user: BaseUserInfo;
}

export interface GetPastGroupEventsResponse {
  groupByUrlname: {
    id: string;
    pastEvents: PaginatedData<PastEvent>;
  };
}

export interface GetPastGroupEventsInput {
  connectionInput: PaginationInput;
  urlname: string;
}

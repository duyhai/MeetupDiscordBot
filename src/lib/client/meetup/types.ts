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
    membershipMetadata: {
      noShowCount: number;
    };
    name: string;
  };
}

export interface GetUserMembershipInfoInput {
  urlname: string;
}

type EventStatus =
  | 'PUBLISHED'
  | 'DRAFT'
  | 'CANCELLED'
  | 'CANCELLED_PERM'
  | 'AUTOSCHED'
  | 'ACTIVE'
  | 'PAST';

interface PastEvent {
  dateTime: string;
  going: number;
  hosts: BaseUserInfo[];
  maxTickets: number;
  status: EventStatus;
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

type TicketStatus =
  | 'YES'
  | 'NO'
  | 'WAITLIST'
  | 'MAYBE'
  | 'ATTENDED'
  | 'NO_SHOW'
  | 'HAVENT'
  | 'EXCUSED_ABSENCE'
  | 'YES_PENDING_PAYMENT';

interface Ticket {
  status: TicketStatus;
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

export interface CreateEventInput {
  communicationSettings: {
    chat: boolean;
    comments: boolean;
  };
  // covidPrecautions: undefined;
  description: string;
  duration: string;
  eventHosts: number[];
  featuredPhotoId: number;
  fundraising: {
    enabled: boolean;
  };
  groupUrlname: string;
  isCopy: boolean;
  publishStatus: string;
  question: string;
  rsvpSettings: {
    guestLimit: number;
    rsvpCloseDuration: string;
    rsvpLimit: number;
    rsvpOpenDuration: string;
  };
  selfRsvp: boolean;
  startDateTime: string;
  title: string;
  topics: number[];
}

export interface CreateEventResponse {
  createEvent: { event: { eventUrl: string } };
}

export interface GetEventResponse {
  event: { description: string; title: string };
}

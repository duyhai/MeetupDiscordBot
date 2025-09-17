interface BaseUserInfo {
  id: string;
  name: string;
}

export interface PaginationInput {
  after?: string;
  before?: string;
  first: number;
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
  edges: {
    node: TData;
  }[];
  pageInfo: PageInfo;
  totalCount: number;
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
    membershipMetadata: {
      joinTime: string;
      rsvpStats: MembershipRsvpStats;
      status: MembershipStatus;
    };
    name: string;
  };
}

export interface GetUserMembershipInfoInput {
  urlname: string;
}

export interface MembershipRsvpStats {
  noShowCount: number;
}

type MembershipStatus =
  | 'ABANDONED'
  | 'ACTIVE'
  // Active member that is not part of the Group's leadership team
  | 'BLOCKED'
  | 'BOOTED'
  | 'BOUNCED'
  | 'DEAD'
  | 'GROUP_BLOCKED'
  | 'GROUP_BLOCKED_ORG'
  | 'INCOMPLETE'
  | 'LEADER'
  // Leaders are Organizers, Co-Organizers, Assistant Organizers, OR Event Organizers
  | 'PENDING'
  // Pending organizer join approval
  | 'PENDING_PAYMENT'
  // Pending membership dues payment
  | 'REMOVED'
  | 'UNAPPROVED';

type EventStatus =
  | 'ACTIVE'
  | 'AUTOSCHED'
  | 'AUTOSCHED_CANCELLED'
  | 'AUTOSCHED_DRAFT'
  | 'AUTOSCHED_FINISHED'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'CANCELLED_PERM'
  | 'DRAFT'
  | 'PAST'
  | 'PENDING'
  | 'PROPOSED'
  | 'TEMPLATE';

interface Event {
  dateTime: string;
  eventHosts: {
    member: BaseUserInfo;
  }[];
  id: string;
  maxTickets: number;
  rsvps: PaginatedData<Ticket> & {
    yesCount: number;
  };
  status: EventStatus;
  title: string;
}

export interface GroupEventFilter {
  // Show only events starting after the specified date.
  afterDateTime?: string;

  // Show only events starting before the specified date.
  beforeDateTime?: string;

  // Show only events hosted by the specified member.
  hostId?: string;

  // Show only events in the specified statuses.
  status?: EventStatus[];

  // Show only events with title matching the specified string (case-insensitive).
  title?: string;
}

interface EventGroupInfo {
  dateTime: string;
  eventUrl: string;
  group: { id: string };
  id: string;
  networkEvent: {
    isAnnounced: boolean;
  };
  title: string;
}

export interface GetUserHostedEventsResponse {
  self: {
    id: string;
    memberEvents: PaginatedData<EventGroupInfo>;
  };
}

export interface GetUserHostedEventsInput {
  after?: string;
  first: number;
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
  member: BaseUserInfo;
  status: TicketStatus;
}

export interface GetGroupEventsResponse {
  groupByUrlname: {
    events: PaginatedData<Event>;
    id: string;
  };
}

export interface GetGroupEventsInput {
  after?: string;
  filter?: GroupEventFilter;
  first: number;
  urlname: string;
}

export interface CreateEventInput {
  communicationSettings: {
    chat: boolean;
    comments: boolean;
  };
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
  createEvent: { event: { eventUrl: string; id: string } };
}

export type EditEventInput = Partial<CreateEventInput> & { eventId: string };

export interface EditEventResponse {
  editEvent: { event: { eventUrl: string; id: string } };
}

export interface GetEventResponse {
  event: { description: string; id: string; title: string };
}

export interface CloseEventRsvpsInput {
  eventId: string;
}

export interface CloseEventRsvpsResponse {
  closeEventRsvps: { event: { id: string } };
}

export interface PublishEventDraftInput {
  eventId: string;
}

export interface PublishEventDraftResponse {
  publishEventDraft: { event: { id: string } };
}

export interface AnnounceEventInput {
  eventId: string;
}

export interface AnnounceEventResponse {
  announceEvent: { event: { id: string } };
}

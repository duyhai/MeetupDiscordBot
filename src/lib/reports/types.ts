/**
 * Payload types for stored report snapshots. Everything here is JSON-safe and
 * carries only what the dashboard shows: members are `{ id, name, memberUrl }`
 * and events never include descriptions or fees.
 */
export type ReportType = 'hall_of_fame' | 'no_show';
export const REPORT_TYPES: readonly ReportType[] = ['hall_of_fame', 'no_show'];
export const PAYLOAD_VERSION = 1;

/** A member as stored: never gender, never anything else. */
export interface MemberRef {
  id: string;
  name: string;
  memberUrl: string;
}

/** An event as stored: never description or fee. */
export interface EventRef {
  id: string;
  title: string;
  eventUrl: string;
  dateTime: string;
}

export interface HallOfFameEvent extends EventRef {
  maxTickets: number;
  /**
   * The RSVP count when the report was built: YES, plus ATTENDED if a host
   * ever marks it. Hosts here mark no-shows only, so this is not a count of
   * who attended; never label it "attended".
   */
  attendance: number;
  eventHosts: { member: MemberRef }[];
}

export interface HallOfFameSummary {
  events: number;
  hosts: number;
  newHosts: number;
}

export interface HallOfFamePayload {
  version: 1;
  reportType: 'hall_of_fame';
  /** 'YYYY-MM'; 'YYYY' only for a whole-year command run (never stored). */
  period: string;
  /** ISO instant the report counts up to. */
  asOf: string;
  summary: HallOfFameSummary;
  totalEvents: number;
  /** Ranked as collectHostStats sorts: most events first, ties in first-seen order. */
  hosts: { host: MemberRef; isNew: boolean; events: HallOfFameEvent[] }[];
}

/**
 * What the month's no-show marking looks like. ATTENDED plays no part: hosts
 * here mark no-shows only, so Meetup returns no ATTENDED RSVPs.
 */
export interface AttendanceEvidence {
  /** Non-cancelled events that started before asOf and have a YES RSVP. */
  pastEventsWithRsvps: number;
  /** Of those, how many have at least one NO_SHOW RSVP. */
  eventsWithNoShow: number;
  /** NO_SHOW RSVPs on those events. */
  noShows: number;
}

export interface NoShowSummary {
  /** NO_SHOW RSVPs on the month's events before asOf. */
  noShows: number;
  /** Distinct members with one. */
  members: number;
  warnings: number;
  suspensionCandidates: number;
  cleared: number;
  departed: number;
}

export interface NoShowCasePayload {
  member: MemberRef;
  classification: 'warning' | 'suspension';
  /** Countable no-shows, oldest first. */
  counted: EventRef[];
  since: { day: string; reason: 'twelve-months' | 'last-suspension' };
  /** Suspensions on record (as of the build's suspension cutoff). */
  priorSuspensions: number;
  /** 30 x 2^prior: the suspension this member gets next (for a warning: if they no-show again). */
  recommendedDays: number;
  /** Has hosted at least one PAST group event before asOf (fee waiver). */
  hostedPastEvent: boolean;
}

export interface NoShowPayload {
  version: 1;
  reportType: 'no_show';
  period: string;
  asOf: string;
  summary: NoShowSummary;
  attendance: AttendanceEvidence;
  cases: NoShowCasePayload[];
  cleared: { member: MemberRef; lastSuspendedDay?: string }[];
  departed: MemberRef[];
}

/** Copies the three stored fields only, so gender and bios never leak in. */
export function toMemberRef(member: {
  id: string;
  name: string;
  memberUrl: string;
}): MemberRef {
  return { id: member.id, name: member.name, memberUrl: member.memberUrl };
}

/** Copies the four stored fields only, so descriptions and fees never leak in. */
export function toEventRef(event: {
  id: string;
  title: string;
  eventUrl: string;
  dateTime: string;
}): EventRef {
  return {
    id: event.id,
    title: event.title,
    eventUrl: event.eventUrl,
    dateTime: event.dateTime,
  };
}

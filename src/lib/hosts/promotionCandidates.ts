import dayjs from 'dayjs';

import { GUEST_HOST_MEETUP_BLACKLIST } from '../../constants.js';
import { mapWithConcurrency } from '../client/meetup/paginationHelper.js';
import { HostEvent, HostEventsDeps, countedOnly } from './hostEvents.js';
// Registers dayjs's utc plugin.
import '../../util/timezone.js';

/**
 * Counted hosted events (countedEvents.ts) in the last CANDIDATE_WINDOW_MONTHS
 * a regular host needs to be listed (spec "Promotion", leadership 2026-11-10).
 */
export const PROMOTION_MIN_EVENTS = 20;
export const CANDIDATE_WINDOW_MONTHS = 18;
/** Group membership a candidate needs: joined a year or more ago. */
export const MIN_MEMBERSHIP_DAYS = 365;
const LOOKUP_CONCURRENCY = 4;

export interface HostSeen {
  meetupMemberId: string;
  name: string;
  /** ISO start of their latest counted past event in the window. */
  lastHosted: string;
}

export interface PromotionCandidate extends HostSeen {
  /** Counted hosted events in the window. */
  recentCount: number;
  /** Counted hosted events all time. */
  pastCount: number;
  /** ISO: when they joined the group on Meetup. */
  memberSince: string;
}

/** A member's standing in the group on Meetup. */
export interface GroupMembership {
  /** Meetup's MembershipStatus; LEADER is an organizer. */
  status: string;
  /** ISO. */
  joinTime: string;
}

export interface CandidateDeps {
  fetchGroupEvents: HostEventsDeps['fetchGroupEvents'];
  /** Every PAST hosted event of one member, all time. */
  pastHostedEvents: (meetupMemberId: string) => Promise<HostEvent[]>;
  /**
   * These members' group memberships; a member no longer in the group is
   * absent. Throws when Meetup cannot answer.
   */
  memberships: (
    meetupMemberIds: string[],
  ) => Promise<Map<string, GroupMembership>>;
  /** Holds the Organizer Discord role (through the identity link); false when unlinked. */
  isOrganizer: (meetupMemberId: string) => Promise<boolean>;
  now: () => Date;
}

/** Every host of the given events, latest event each. */
export function hostsSeen(events: HostEvent[]): Map<string, HostSeen> {
  const seen = new Map<string, HostSeen>();
  for (const event of events) {
    for (const host of event.hosts) {
      if (!/^[1-9][0-9]{0,19}$/.test(host.id)) {
        continue;
      }
      const known = seen.get(host.id);
      if (
        known === undefined ||
        dayjs(event.dateTime).isAfter(dayjs(known.lastHosted))
      ) {
        seen.set(host.id, {
          meetupMemberId: host.id,
          name: host.name,
          lastHosted: event.dateTime,
        });
      }
    }
  }
  return seen;
}

/** Counted hosted events per host id. */
function countsByHost(events: HostEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    for (const id of new Set(event.hosts.map((h) => h.id))) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

export interface CandidateList {
  candidates: PromotionCandidate[];
  /** Every host of the window's counted events, for names. */
  seen: Map<string, HostSeen>;
  /** Hosts whose lookups failed: they may be missing. */
  uncounted: number;
}

/**
 * Regular hosts who may be promoted, most recent events first: hosts of
 * the window's counted events with PROMOTION_MIN_EVENTS or more of them,
 * who joined the group MIN_MEMBERSHIP_DAYS or more ago, less organizers
 * (Meetup LEADER status or the Organizer Discord role), anyone in
 * `excluded` (the active Community Hosts), the Meetup blacklist and anyone
 * who has left the group. The event and membership reads failing fail the
 * list; a host whose own lookups fail is left out and counted in
 * `uncounted`.
 */
export async function promotionCandidates(
  deps: CandidateDeps,
  excluded: ReadonlySet<string>,
): Promise<CandidateList> {
  // UTC arithmetic: a local-time month subtraction across a DST change
  // would move the window's start by an hour.
  const now = dayjs(deps.now()).utc();
  const events = countedOnly(
    await deps.fetchGroupEvents({
      status: ['PAST'],
      afterDateTime: now
        .subtract(CANDIDATE_WINDOW_MONTHS, 'month')
        .toISOString(),
      beforeDateTime: now.toISOString(),
    }),
  );
  const seen = hostsSeen(events);
  const recent = countsByHost(events);
  const enough = [...seen.values()].filter(
    (h) =>
      (recent.get(h.meetupMemberId) ?? 0) >= PROMOTION_MIN_EVENTS &&
      !excluded.has(h.meetupMemberId) &&
      !GUEST_HOST_MEETUP_BLACKLIST.includes(h.meetupMemberId),
  );
  if (enough.length === 0) {
    return { candidates: [], seen, uncounted: 0 };
  }
  const memberships = await deps.memberships(
    enough.map((h) => h.meetupMemberId),
  );
  const joinedBefore = now.subtract(MIN_MEMBERSHIP_DAYS, 'day');
  const eligible = enough.flatMap((host) => {
    const membership = memberships.get(host.meetupMemberId);
    if (
      membership === undefined ||
      membership.status === 'LEADER' ||
      !dayjs(membership.joinTime).isBefore(joinedBefore)
    ) {
      return [];
    }
    return [{ host, membership }];
  });
  const looked = await mapWithConcurrency(
    eligible,
    LOOKUP_CONCURRENCY,
    async ({ host, membership }) => {
      try {
        if (await deps.isOrganizer(host.meetupMemberId)) {
          return null;
        }
        const past = countedOnly(
          await deps.pastHostedEvents(host.meetupMemberId),
        );
        return {
          ...host,
          recentCount: recent.get(host.meetupMemberId) ?? 0,
          pastCount: past.length,
          memberSince: membership.joinTime,
        } satisfies PromotionCandidate;
      } catch {
        return undefined;
      }
    },
  );
  const candidates = looked
    .filter((c): c is PromotionCandidate => c !== undefined && c !== null)
    .sort(
      (a, b) =>
        b.recentCount - a.recentCount ||
        b.pastCount - a.pastCount ||
        a.name.localeCompare(b.name) ||
        a.meetupMemberId.localeCompare(b.meetupMemberId),
    );
  return {
    candidates,
    seen,
    uncounted: looked.filter((c) => c === undefined).length,
  };
}

/**
 * `read` kept for `ttlMs`, one read at a time (a second caller awaits the
 * first). A failure is not kept, so the next call reads again; nor is a
 * value `keep` refuses. A caller that stops waiting (the page's own
 * deadline) leaves the read running, and if it finishes within `timeoutMs`
 * its result is kept for the reload. Past `timeoutMs` the read fails its
 * callers and frees the slot: its late result is dropped and the next call
 * starts a fresh read, so a hung read never pins later callers.
 */
export function singleFlight<T>(
  read: () => Promise<T>,
  ttlMs: number,
  options: {
    now?: () => number;
    timeoutMs?: number;
    keep?: (value: T) => boolean;
  } = {},
): () => Promise<T> {
  const now = options.now ?? Date.now;
  let kept: { at: number; value: T } | undefined;
  let inFlight: Promise<T> | undefined;
  return async () => {
    if (kept !== undefined && now() - kept.at < ttlMs) {
      return kept.value;
    }
    if (inFlight === undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // A timed-out read is not cancelled: it runs on, and its late result
      // is dropped, so it never overwrites a newer list or restarts the TTL.
      let timedOut = false;
      const reading = read().then((value) => {
        if (!timedOut && (options.keep?.(value) ?? true)) {
          kept = { at: now(), value };
        }
        return value;
      });
      const limited =
        options.timeoutMs === undefined
          ? reading
          : Promise.race([
              reading,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  timedOut = true;
                  reject(new Error('read timed out'));
                }, options.timeoutMs);
              }),
            ]);
      const pending = limited.finally(() => {
        clearTimeout(timer);
        if (inFlight === pending) {
          inFlight = undefined;
        }
      });
      // A caller that gave up still leaves these handled.
      reading.catch(() => undefined);
      pending.catch(() => undefined);
      inFlight = pending;
    }
    return inFlight;
  };
}

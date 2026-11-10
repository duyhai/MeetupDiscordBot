import {
  GUEST_HOST_BLACKLIST,
  GUEST_HOST_MEETUP_BLACKLIST,
} from '../../constants.js';

export type HostTier = 'regular' | 'promoted';

/**
 * Everything resolveHost reads. Each lookup throws when its source cannot be
 * reached; resolveHost lets that propagate, so the caller can answer "try
 * again" instead of guessing someone in or out.
 */
export interface HostResolveDeps {
  discordIdForMeetup: (meetupId: string) => Promise<string | undefined>;
  meetupIdForDiscord: (discordId: string) => Promise<string | undefined>;
  /** Holds the Guest Host role, asked of Discord live. */
  hasGuestHostRole: (discordId: string) => Promise<boolean>;
  /** Counted PAST events hosted by this member (countedEvents.ts; organizer credential). */
  pastHostedCount: (meetupId: string) => Promise<number>;
  isPromoted: (meetupId: string) => Promise<boolean>;
}

export type HostResolution =
  | {
      kind: 'host';
      meetupMemberId: string;
      discordUserId?: string;
      tier: HostTier;
      /** Undefined when the Guest Host role decided and the count was not read. */
      hostedCount?: number;
    }
  /**
   * Linked (both ids), on neither blacklist, but not a host: admitted to the
   * member area (home and Wrapped) only.
   */
  | { kind: 'member'; meetupMemberId: string; discordUserId: string }
  | { kind: 'refused'; reason: 'not-linked' | 'blacklisted' | 'not-a-host' };

export type HostIdentity =
  { meetupMemberId: string } | { discordUserId: string };

const isBlacklisted = (meetupId: string, discordId: string | undefined) =>
  GUEST_HOST_MEETUP_BLACKLIST.includes(meetupId) ||
  (discordId !== undefined && GUEST_HOST_BLACKLIST.includes(discordId));

/**
 * Who may use the host dashboard, and at which tier (spec "Users and
 * tiers"). Both sign-in paths end here with one person and their Meetup
 * member id: a Discord sign-in needs a linked Meetup account (the dashboard
 * is keyed by it); a Meetup sign-in may have no Discord link. A host holds
 * the Guest Host role or has at least one past hosted event, and is on
 * neither blacklist (checked first, before any Meetup read). Promoted is a
 * row in promoted_hosts. A linked member who is not a host is a `member`
 * (Wrapped addendum): the member area only.
 */
export async function resolveHost(
  deps: HostResolveDeps,
  who: HostIdentity,
): Promise<HostResolution> {
  let meetupMemberId: string;
  let discordUserId: string | undefined;
  if ('discordUserId' in who) {
    discordUserId = who.discordUserId;
    const linked = await deps.meetupIdForDiscord(discordUserId);
    if (!linked) {
      return { kind: 'refused', reason: 'not-linked' };
    }
    meetupMemberId = linked;
  } else {
    meetupMemberId = who.meetupMemberId;
    discordUserId = await deps.discordIdForMeetup(meetupMemberId);
  }
  if (isBlacklisted(meetupMemberId, discordUserId)) {
    return { kind: 'refused', reason: 'blacklisted' };
  }
  let hostedCount: number | undefined;
  const hasRole =
    discordUserId !== undefined && (await deps.hasGuestHostRole(discordUserId));
  if (!hasRole) {
    hostedCount = await deps.pastHostedCount(meetupMemberId);
    if (hostedCount < 1) {
      // Not a host. Linked: a member (Wrapped only). Unlinked: the next
      // step for them is to link, so that is what the refusal says.
      if (discordUserId === undefined) {
        return { kind: 'refused', reason: 'not-linked' };
      }
      return { kind: 'member', meetupMemberId, discordUserId };
    }
  }
  const tier: HostTier = (await deps.isPromoted(meetupMemberId))
    ? 'promoted'
    : 'regular';
  return {
    kind: 'host',
    meetupMemberId,
    ...(discordUserId !== undefined ? { discordUserId } : {}),
    tier,
    ...(hostedCount !== undefined ? { hostedCount } : {}),
  };
}

/**
 * The tier a request is published at, from the host's resolution now. A
 * member who is neither blacklisted nor (yet) a host publishes as a regular
 * host: a first-time host's Discord request has no role and no past event,
 * and leadership's approval is the gate. Only a blacklisting refuses.
 */
export function publishTier(
  resolution: HostResolution,
): HostTier | 'not-a-host' {
  if (resolution.kind === 'host') {
    return resolution.tier;
  }
  if (resolution.kind === 'member') {
    return 'regular';
  }
  return resolution.reason === 'blacklisted' ? 'not-a-host' : 'regular';
}

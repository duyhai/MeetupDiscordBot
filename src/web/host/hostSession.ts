import type { HostTier } from '../../lib/hosts/eligibility.js';
import { DashboardSession, SessionStoreOptions } from '../session.js';

export const HOST_BASE = '/host';
export const HOST_SESSION_COOKIE = 'host_sid';
/** The MAC domains of the host cookies: a staff cookie never verifies here. */
export const HOST_SID_DOMAIN = 'host-sid';
export const HOST_OAUTH_DOMAIN = 'host-oauth';

/**
 * A host dashboard session. `userId` is the Meetup member id (the host
 * dashboard is keyed by it, since a host may have no linked Discord) and
 * `username` the name shown in the header. `roleCheckedAt` is when the tier
 * was last re-checked.
 */
export interface HostSession extends DashboardSession {
  discordUserId: string | null;
  tier: HostTier;
  /**
   * A host has every page; a member (linked, never hosted) has home and
   * Wrapped. Sessions written before roles existed carry none and are read
   * as hosts: only hosts were admitted then.
   */
  role: HostRole;
  via: 'discord' | 'meetup';
}

export type HostRole = 'host' | 'member';

const DISCORD_ID = /^[0-9]{17,20}$/;

export const HOST_SESSION_OPTIONS: SessionStoreOptions<HostSession> =
  Object.freeze({
    keyPrefix: 'host-session-',
    validAfterPrefix: 'host-user-valid-after-',
    userIdPattern: /^[1-9][0-9]{0,19}$/,
    isExtra: (
      v: Record<string, unknown>,
    ): v is Record<string, unknown> &
      Omit<HostSession, keyof DashboardSession> =>
      (v.discordUserId === null ||
        (typeof v.discordUserId === 'string' &&
          DISCORD_ID.test(v.discordUserId))) &&
      (v.tier === 'regular' || v.tier === 'promoted') &&
      (v.role === undefined || v.role === 'host' || v.role === 'member') &&
      (v.via === 'discord' || v.via === 'meetup'),
  });

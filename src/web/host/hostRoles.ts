import { SERVER_ROLES } from '../../constants.js';
import type {
  HostResolveDeps,
  StaffRole,
} from '../../lib/hosts/eligibility.js';

/** How long one live role read answers the same member again. */
export const ROLE_READ_REUSE_MS = 5_000;

/** The badge's staff roles, highest first. */
const STAFF_BADGE_ROLES: [StaffRole, string][] = [
  ['leadership', SERVER_ROLES.leadership],
  ['organizer', SERVER_ROLES.organizer],
];

/**
 * A member's role ids, read once and reused for `reuseMs`: one resolve asks
 * for the Guest Host check and the badge within a second of each other. Per
 * member; a read that fails is dropped (only that read: a newer one for the
 * same member stays), so the next ask reads again.
 */
export function sharedRoleReads(
  fetchRoles: (discordUserId: string) => Promise<string[]>,
  reuseMs: number = ROLE_READ_REUSE_MS,
  now: () => number = Date.now,
): (discordUserId: string) => Promise<string[]> {
  const recent = new Map<string, { at: number; roles: Promise<string[]> }>();
  return (discordUserId) => {
    const at = now();
    for (const [id, hit] of recent) {
      if (at - hit.at >= reuseMs) {
        recent.delete(id);
      }
    }
    const hit = recent.get(discordUserId);
    if (hit) {
      return hit.roles;
    }
    const roles = fetchRoles(discordUserId);
    const entry = { at, roles };
    recent.set(discordUserId, entry);
    roles.catch(() => {
      if (recent.get(discordUserId) === entry) {
        recent.delete(discordUserId);
      }
    });
    return roles;
  };
}

/** resolveHost's two role lookups, both from one (shared) role read. */
export function hostRoleChecks(
  rolesOf: (discordUserId: string) => Promise<string[]>,
): Pick<HostResolveDeps, 'hasGuestHostRole' | 'staffRoles'> {
  return {
    hasGuestHostRole: async (discordUserId) =>
      (await rolesOf(discordUserId)).includes(SERVER_ROLES.guest_host),
    staffRoles: async (discordUserId) => {
      const roles = await rolesOf(discordUserId);
      return STAFF_BADGE_ROLES.filter(([, id]) => roles.includes(id)).map(
        ([role]) => role,
      );
    },
  };
}

import crypto from 'crypto';
import { vi } from 'vitest';

import { OAuthStateRecord } from '../../../src/lib/client/oauth/state.js';
import { DashboardPageDeps } from '../../../src/web/routes/dashboardPages.js';
import { OrganizerLoginDeps } from '../../../src/web/routes/organizerLogin.js';

export const PAGE_NOW = new Date('2026-10-05T16:15:00Z');

/** Page deps for route tests and the access matrix. Later tasks add fixture-backed fakes. */
export function fakePageDeps(
  overrides: Partial<DashboardPageDeps> = {},
): DashboardPageDeps {
  return {
    now: () => PAGE_NOW,
    ...overrides,
  };
}

const ORGANIZER_ID = '468174923';
const MEETUP_AUTHORIZE = 'https://secure.meetup.com/oauth2/authorize';

/** An in-memory stand-in for the OAuth state store. */
function fakeStates() {
  const records = new Map<string, OAuthStateRecord>();
  const claimed = new Set<string>();
  return {
    createState: vi.fn(async (discordUserId: string, sessionHash: string) => {
      const state = crypto.randomUUID();
      records.set(state, {
        discordUserId,
        purpose: 'organizer-renew',
        sessionHash,
      });
      return state;
    }),
    resolveState: vi.fn(async (state: string) => records.get(state)),
    claimState: vi.fn(async (state: string) => {
      if (claimed.has(state)) {
        return false;
      }
      claimed.add(state);
      return true;
    }),
  };
}

/** Organizer login deps with the same default resolutions as organizerLogin.test.ts. */
export function fakeOrganizerDeps(
  overrides: Partial<OrganizerLoginDeps> = {},
): OrganizerLoginDeps {
  const states = fakeStates();
  return {
    credentialStatus: vi.fn().mockResolvedValue({
      memberId: ORGANIZER_ID,
      failingSince: null,
      stored: true,
    }),
    expectedMemberId: vi.fn().mockResolvedValue(ORGANIZER_ID),
    createState: states.createState,
    resolveState: states.resolveState,
    claimState: states.claimState,
    buildAuthUrl: vi.fn(
      (state: string) => `${MEETUP_AUTHORIZE}?state=${state}&client_id=k`,
    ),
    exchangeCode: vi.fn().mockResolvedValue({
      accessToken: 'fake-access',
      refreshToken: 'fake-refresh',
      expiresAt: PAGE_NOW.getTime() + 3600_000,
    }),
    fetchMeetupMemberId: vi.fn().mockResolvedValue(ORGANIZER_ID),
    saveRenewedCredential: vi.fn().mockResolvedValue(undefined),
    audit: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

import crypto from 'crypto';
import { vi } from 'vitest';

import { OAuthStateRecord } from '../../../src/lib/client/oauth/state.js';
import {
  Period,
  comparePeriods,
  periodKey,
} from '../../../src/lib/reports/period.js';
import {
  HallOfFameEvent,
  HallOfFamePayload,
  MemberRef,
  ReportType,
} from '../../../src/lib/reports/types.js';
import {
  Snapshot,
  SnapshotMeta,
} from '../../../src/lib/repositories/postgresReportSnapshotRepository.js';
import {
  DashboardPageDeps,
  PageRebuildResult,
  SnapshotPageReader,
} from '../../../src/web/routes/dashboardPages.js';
import { OrganizerLoginDeps } from '../../../src/web/routes/organizerLogin.js';
import { SessionStore } from '../../../src/web/session.js';
import { FakeCache } from '../fakeCache.js';

export const PAGE_NOW = new Date('2026-10-05T16:15:00Z');
export const SEPT: Period = { year: 2026, month: 9 };

/** A stored row: its meta and its payload. */
export interface SeedRow {
  meta: SnapshotMeta;
  payload: unknown;
}

let seedIds = 0;

export function seedRow(
  reportType: ReportType,
  period: Period,
  payload: unknown,
  meta: Partial<SnapshotMeta> = {},
): SeedRow {
  seedIds += 1;
  return {
    meta: {
      id: seedIds,
      reportType,
      period,
      builtAt: new Date('2026-10-01T15:00:00Z'),
      builtBy: 'job',
      sourceComplete: true,
      summary: (payload as { summary?: unknown } | null)?.summary ?? null,
      attendance: null,
      ...meta,
    },
    payload,
  };
}

const samePeriod = (a: Period, b: Period) =>
  a.year === b.year && a.month === b.month;

/** An in-memory SnapshotPageReader over seeded rows; every method is a vi.fn. */
export function fakeSnapshots(rows: SeedRow[]) {
  const find = (type: ReportType, period: Period) =>
    rows.find(
      (r) => r.meta.reportType === type && samePeriod(r.meta.period, period),
    );
  const newestFirst = (type: ReportType) =>
    rows
      .filter((r) => r.meta.reportType === type)
      .sort((a, b) => comparePeriods(b.meta.period, a.meta.period));
  return {
    getCurrent: vi.fn(
      async (
        type: ReportType,
        period: Period,
      ): Promise<Snapshot | undefined> => {
        const row = find(type, period);
        return row ? { ...row.meta, payload: row.payload } : undefined;
      },
    ),
    getCurrentMeta: vi.fn(
      async (
        type: ReportType,
        period: Period,
      ): Promise<SnapshotMeta | undefined> => find(type, period)?.meta,
    ),
    listSummaries: vi.fn(
      async (
        type: ReportType,
        options: { limit?: number; before?: Period } = {},
      ): Promise<SnapshotMeta[]> =>
        newestFirst(type)
          .filter(
            (r) =>
              options.before === undefined ||
              comparePeriods(r.meta.period, options.before) < 0,
          )
          .slice(0, options.limit ?? 50)
          .map((r) => r.meta),
    ),
    listSummarySeries: vi.fn(
      async (
        type: ReportType,
        options: { months?: number } = {},
      ): Promise<SnapshotMeta[]> =>
        newestFirst(type)
          .slice(0, options.months ?? 24)
          .reverse()
          .map((r) => r.meta),
    ),
    listMemberNoShowMonths: vi.fn(async () => []),
  } satisfies SnapshotPageReader;
}

const meetupMember = (i: number, name = `Host ${i}`): MemberRef => ({
  id: String(1000 + i),
  name,
  memberUrl: `https://www.meetup.com/members/${1000 + i}/`,
});

const hofEvent = (
  id: string,
  title: string,
  eventUrl: string,
  hosts: MemberRef[],
): HallOfFameEvent => ({
  id,
  title,
  eventUrl,
  dateTime: '2026-09-04T02:00:00.000Z',
  maxTickets: 10,
  attendance: 7,
  eventHosts: hosts.map((member) => ({ member })),
});

export const REAL_EVENT_URL = 'https://www.meetup.com/1-5genasians/events/9/';

/**
 * September 2026 with 60 hosts. Host 0 has a hostile name and memberUrl, is
 * new, and hosts a hostile event and a real one (co-hosted by Host 1).
 */
export function hofPayload(
  overrides: Partial<HallOfFamePayload> = {},
): HallOfFamePayload {
  const host0: MemberRef = {
    ...meetupMember(0, '<script>alert(1)</script>\u202e'),
    memberUrl: 'https://evil.example/',
  };
  const host1 = meetupMember(1);
  const hosts: HallOfFamePayload['hosts'] = [
    {
      host: host0,
      isNew: true,
      events: [
        hofEvent('1', '"><img src=x onerror=alert(1)>', 'javascript:alert(1)', [
          host0,
        ]),
        hofEvent('9', 'Board games', REAL_EVENT_URL, [host0, host1]),
      ],
    },
  ];
  for (let i = 1; i < 60; i += 1) {
    const host = i === 1 ? host1 : meetupMember(i);
    hosts.push({
      host,
      isNew: false,
      events: [
        hofEvent(
          String(100 + i),
          `Event ${i}`,
          `https://www.meetup.com/1-5genasians/events/${100 + i}/`,
          [host],
        ),
      ],
    });
  }
  return {
    version: 1,
    reportType: 'hall_of_fame',
    period: periodKey(SEPT),
    asOf: '2026-10-01T07:00:00.000Z',
    summary: { events: 61, hosts: 60, newHosts: 1 },
    totalEvents: 61,
    hosts,
    ...overrides,
  };
}

/** The default seed: a September 2026 Hall of Fame row. */
export const SEED: SeedRow[] = [seedRow('hall_of_fame', SEPT, hofPayload())];

/** Page deps for route tests and the access matrix. Later tasks add fixture-backed fakes. */
export function fakePageDeps(
  overrides: Partial<DashboardPageDeps> = {},
): DashboardPageDeps {
  return {
    now: () => PAGE_NOW,
    sessionStore: () =>
      Promise.resolve(
        new SessionStore(new FakeCache(), () => PAGE_NOW.getTime()),
      ),
    isLeadership: vi.fn().mockResolvedValue(false),
    audit: vi.fn().mockResolvedValue(true),
    snapshots: async () => fakeSnapshots(SEED),
    rebuild: vi.fn(async (): Promise<PageRebuildResult> => ({
      status: 'started',
      done: Promise.resolve({ ok: true }),
    })),
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

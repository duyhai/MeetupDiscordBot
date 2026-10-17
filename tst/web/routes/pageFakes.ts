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
  NoShowCasePayload,
  NoShowPayload,
  ReportType,
} from '../../../src/lib/reports/types.js';
import {
  MemberNoShowMonth,
  Snapshot,
  SnapshotMeta,
} from '../../../src/lib/repositories/postgresReportSnapshotRepository.js';
import {
  IdentityNames,
  IdentitySubject,
  identityNameKey,
} from '../../../src/lib/helpers/identity/names.js';
import {
  IdentityChangeFilter,
  IdentityChangeListItem,
} from '../../../src/lib/repositories/postgresIdentityRepository.js';
import { LinkProgressDay } from '../../../src/lib/repositories/postgresLinkProgressRepository.js';
import {
  SuspensionPageRow,
  SuspensionRecordState,
  SuspensionState,
} from '../../../src/lib/repositories/postgresSuspensionRepository.js';
import { SuspensionRecord } from '../../../src/lib/repositories/types.js';
import { UpcomingEntry } from '../../../src/lib/workspace/upcoming.js';
import {
  DashboardPageDeps,
  IdentityPageReader,
  LinkProgressPageReader,
  MemberLinkPageReader,
  PageRebuildResult,
  SnapshotPageReader,
  SuspensionPageReader,
  WorkspaceActions,
  WorkspacePageReader,
} from '../../../src/web/routes/dashboardPages.js';
import {
  WorkspaceActionResult,
  WorkspaceSyncCode,
} from '../../../src/lib/workspace/service.js';
import {
  WorkspaceEvent,
  WorkspaceMonthState,
  WorkspaceRow,
  WorkspaceStatus,
} from '../../../src/lib/workspace/types.js';
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
export function fakeSnapshots(
  rows: SeedRow[],
  memberMonths: MemberNoShowMonth[] = [],
) {
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
    listMemberNoShowMonths: vi.fn(
      async (
        _memberId: string,
        _options: { offset?: number; limit?: number } = {},
      ): Promise<MemberNoShowMonth[]> => memberMonths,
    ),
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

const noShowEvent = (i: number, title = `Event ${i}`) => ({
  id: String(500 + i),
  title,
  eventUrl: `https://www.meetup.com/1-5genasians/events/${500 + i}/`,
  dateTime: '2026-09-04T02:00:00.000Z',
});

/** One no-show case for member 2000+i; a warning unless `classification` says otherwise. */
export function noShowCase(
  i: number,
  overrides: Partial<NoShowCasePayload> = {},
): NoShowCasePayload {
  return {
    member: meetupMember(1000 + i, `Member ${i}`),
    classification: 'warning',
    counted: [noShowEvent(i)],
    since: { day: '2025-10-01', reason: 'twelve-months' },
    priorSuspensions: 0,
    recommendedDays: 30,
    hostedPastEvent: false,
    ...overrides,
  };
}

/**
 * September 2026 no-show report. Case 0 has a hostile name and memberUrl and
 * a hostile event title and URL; case 1 is a suspension candidate.
 */
export function noShowPayload(
  overrides: Partial<NoShowPayload> = {},
): NoShowPayload {
  const hostile: NoShowCasePayload = noShowCase(0, {
    member: {
      ...meetupMember(1000, '<script>alert(1)</script>\u202e'),
      memberUrl: 'https://evil.example/',
    },
    counted: [
      {
        ...noShowEvent(0, '"><img src=x onerror=alert(1)>'),
        eventUrl: 'javascript:alert(1)',
      },
      noShowEvent(99, 'Board games'),
    ],
  });
  return {
    version: 1,
    reportType: 'no_show',
    period: periodKey(SEPT),
    asOf: '2026-10-01T07:00:00.000Z',
    summary: {
      noShows: 3,
      members: 2,
      warnings: 1,
      suspensionCandidates: 1,
      cleared: 1,
      departed: 1,
    },
    attendance: { pastEventsWithRsvps: 6, eventsWithNoShow: 2, noShows: 3 },
    cases: [
      hostile,
      noShowCase(1, {
        classification: 'suspension',
        since: { day: '2026-03-02', reason: 'last-suspension' },
        priorSuspensions: 1,
        recommendedDays: 60,
        hostedPastEvent: true,
      }),
    ],
    cleared: [
      {
        member: meetupMember(3000, 'Cleared One'),
        lastSuspendedDay: '2026-08-01',
      },
    ],
    departed: [meetupMember(4000, 'Gone One')],
    ...overrides,
  };
}

let suspensionIds = 0;

/** One suspension page row: a live September 1 30-day record unless overridden. */
export function suspensionRow(
  overrides: Partial<SuspensionPageRow> = {},
): SuspensionPageRow {
  suspensionIds += 1;
  return {
    id: suspensionIds,
    memberId: String(7000 + suspensionIds),
    memberName: `Suspended ${suspensionIds}`,
    suspendedAt: new Date('2026-09-01T00:00:00Z'),
    durationDays: 30,
    notes: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    lastDay: '2026-09-30',
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    linkedName: null,
    linkedDiscordId: null,
    ...overrides,
  };
}

/** One suspension record with its void state: a live September 1 30-day record unless overridden. */
export function suspensionRecord(
  overrides: Partial<SuspensionRecordState> = {},
): SuspensionRecordState {
  suspensionIds += 1;
  return {
    id: suspensionIds,
    memberId: String(7000 + suspensionIds),
    memberName: `Suspended ${suspensionIds}`,
    suspendedAt: new Date('2026-09-01T00:00:00Z'),
    durationDays: 30,
    notes: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    ...overrides,
  };
}

/**
 * An in-memory SuspensionPageReader: rows per tab, sliced by offset/limit
 * like the repository. `records` back listByMemberIds (live only, like the
 * repository) and listByIds (voided included).
 */
export function fakeSuspensions(
  rows: Partial<Record<SuspensionState, SuspensionPageRow[]>> = {},
  byMonth: { month: string; count: number }[] = [],
  records: SuspensionRecordState[] = [],
) {
  const tab = (state: SuspensionState) => rows[state] ?? [];
  return {
    listByMemberIds: vi.fn(
      async (memberIds: string[], before?: Date): Promise<SuspensionRecord[]> =>
        records
          .filter(
            (r) =>
              r.voidedAt === null &&
              memberIds.includes(r.memberId) &&
              (before === undefined || r.suspendedAt < before),
          )
          .map(
            ({ voidedAt: _a, voidedBy: _b, voidReason: _c, ...live }) => live,
          ),
    ),
    listByIds: vi.fn(async (ids: number[]): Promise<SuspensionRecordState[]> =>
      records.filter((r) => ids.includes(r.id)),
    ),
    listPage: vi.fn(
      async (options: {
        state: SuspensionState;
        today: string;
        offset: number;
        limit: number;
      }): Promise<SuspensionPageRow[]> =>
        tab(options.state).slice(
          options.offset,
          options.offset + Math.min(50, options.limit),
        ),
    ),
    countByState: vi.fn(
      async (_today: string): Promise<Record<SuspensionState, number>> => ({
        active: tab('active').length,
        past: tab('past').length,
        voided: tab('voided').length,
      }),
    ),
    countByMonth: vi.fn(
      async (from: Date): Promise<{ month: string; count: number }[]> =>
        byMonth.filter((m) => m.month >= from.toISOString().slice(0, 7)),
    ),
  } satisfies SuspensionPageReader;
}

/** A real 1x1 PNG. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
/** A JPEG/JFIF header. */
export const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
]);
/** A RIFF/WEBP header. */
export const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'latin1'),
  Buffer.alloc(8, 1),
]);

export const DISCORD_SUBJECT = '123456789012345678';

let changeIds = 0;

/** One identity change list row: a Discord nickname change unless overridden. */
export function identityChange(
  overrides: Partial<IdentityChangeListItem> = {},
): IdentityChangeListItem {
  changeIds += 1;
  return {
    id: String(changeIds),
    platform: 'discord',
    scopeId: 'guild',
    subjectId: DISCORD_SUBJECT,
    field: 'nickname',
    oldValue: 'Old Nick',
    newValue: 'New Nick',
    detectedAt: new Date('2026-10-02T17:00:00Z'),
    source: 'sweep',
    hasOldThumb: false,
    hasNewThumb: false,
    ...overrides,
  };
}

/**
 * An in-memory IdentityPageReader. `rows` are returned as listChangesPage's
 * answer (sliced to the limit); `thumbs` maps `${id}:${side}` to bytes.
 */
export function fakeIdentity(
  rows: IdentityChangeListItem[] = [],
  thumbs: Record<string, Buffer> = {},
  names: Record<string, string> = {},
) {
  return {
    listChangesPage: vi.fn(
      async (filter: IdentityChangeFilter): Promise<IdentityChangeListItem[]> =>
        rows.slice(0, Math.min(50, filter.limit ?? 50)),
    ),
    getChangeThumb: vi.fn(
      async (id: string, side: 'old' | 'new'): Promise<Buffer | undefined> =>
        thumbs[`${id}:${side}`],
    ),
    countChangesSince: vi.fn(async (_since: Date): Promise<number> => 0),
    listIdentityNames: vi.fn(
      async (subjects: IdentitySubject[]): Promise<IdentityNames> => {
        const out: IdentityNames = new Map();
        subjects.forEach((s) => {
          const name = names[s.subjectId];
          if (name !== undefined) {
            out.set(identityNameKey(s.platform, s.scopeId, s.subjectId), name);
          }
        });
        return out;
      },
    ),
  } satisfies IdentityPageReader;
}

/** One day of link progress counts. */
export function linkDay(
  day: string,
  overrides: Partial<LinkProgressDay> = {},
): LinkProgressDay {
  return {
    day,
    linked: 100,
    unlinked: 40,
    reverifyTagged: 5,
    onboarding: 3,
    ...overrides,
  };
}

/** `count` consecutive days ending the day before PAGE_NOW, newest first (like listDays). */
export function linkDays(count: number): LinkProgressDay[] {
  const end = Date.UTC(2026, 9, 4);
  return Array.from({ length: count }, (_, i) =>
    linkDay(new Date(end - i * 86_400_000).toISOString().slice(0, 10), {
      linked: 200 - i,
    }),
  );
}

/** An in-memory LinkProgressPageReader over newest-first days, capped like the repository. */
export function fakeLinkProgress(days: LinkProgressDay[] = linkDays(3)) {
  return {
    listDays: vi.fn(async (limit: number = 90): Promise<LinkProgressDay[]> =>
      days.slice(0, Math.min(1000, limit)),
    ),
  } satisfies LinkProgressPageReader;
}

/**
 * A MemberLinkPageReader over a fixed meetup id -> discord id table. The
 * stored discord id is returned as is, valid or not, like the repository.
 */
export function fakeMemberLinks(links: Record<string, string> = {}) {
  return {
    discordIdsByMeetupIds: vi.fn(
      async (ids: string[]): Promise<Map<string, string>> =>
        new Map(
          ids
            .filter((id) => Object.hasOwn(links, id))
            .map((id): [string, string] => [id, links[id]]),
        ),
    ),
  } satisfies MemberLinkPageReader;
}

/** One workspace row: September's suspension case for member 123456, new, version 1, unless overridden. */
export function workspaceRow(
  overrides: Partial<WorkspaceRow> = {},
): WorkspaceRow {
  return {
    id: 1,
    period: SEPT,
    memberId: '123456',
    memberName: 'Test Member',
    classification: 'suspension',
    status: 'new',
    notes: '',
    suspensionRecordId: null,
    inLatestSnapshot: true,
    version: 1,
    updatedAt: new Date('2026-10-01T16:00:00Z'),
    updatedBy: 'sync',
    ...overrides,
  };
}

export interface WorkspaceSeed {
  rows: WorkspaceRow[];
  months: WorkspaceMonthState[];
  events: WorkspaceEvent[];
}

/** The default workspace seed: one September row and September's month state. */
export const WORKSPACE_SEED = (): WorkspaceSeed => ({
  rows: [workspaceRow()],
  months: [
    {
      period: SEPT,
      snapshotId: 1,
      snapshotBuiltAt: new Date('2026-10-01T15:00:00Z'),
      syncedAt: new Date('2026-10-01T16:00:00Z'),
    },
  ],
  events: [],
});

const periodMatch = (a: Period, b: Period) =>
  a.year === b.year && a.month === b.month;

/** An in-memory WorkspacePageReader backed by arrays; every method is a vi.fn. */
export function fakeWorkspace(seed: WorkspaceSeed = WORKSPACE_SEED()) {
  const inMonth = (period: Period) =>
    seed.rows.filter((r) => periodMatch(r.period, period));
  return {
    monthState: vi.fn(
      async (period: Period): Promise<WorkspaceMonthState | undefined> =>
        seed.months.find((m) => periodMatch(m.period, period)),
    ),
    listMonths: vi.fn(async (): Promise<WorkspaceMonthState[]> =>
      [...seed.months].sort((a, b) => comparePeriods(b.period, a.period)),
    ),
    listRows: vi.fn(
      async (
        period: Period,
        page: { offset: number; limit: number },
      ): Promise<WorkspaceRow[]> =>
        inMonth(period).slice(
          page.offset,
          page.offset + Math.min(50, page.limit),
        ),
    ),
    countRows: vi.fn(
      async (period: Period): Promise<{ total: number; inLatest: number }> => ({
        total: inMonth(period).length,
        inLatest: inMonth(period).filter((r) => r.inLatestSnapshot).length,
      }),
    ),
    getRow: vi.fn(
      async (
        period: Period,
        rowId: number,
      ): Promise<WorkspaceRow | undefined> =>
        inMonth(period).find((r) => r.id === rowId),
    ),
    listRecentEvents: vi.fn(
      async (rowIds: number[]): Promise<Map<number, WorkspaceEvent[]>> => {
        const byRow = new Map<number, WorkspaceEvent[]>();
        for (const event of seed.events) {
          if (rowIds.includes(event.rowId)) {
            byRow.set(event.rowId, [...(byRow.get(event.rowId) ?? []), event]);
          }
        }
        return byRow;
      },
    ),
    statusCounts: vi.fn(
      async (
        periods: Period[],
      ): Promise<Map<string, Partial<Record<WorkspaceStatus, number>>>> => {
        const counts = new Map<
          string,
          Partial<Record<WorkspaceStatus, number>>
        >();
        for (const period of periods) {
          for (const row of inMonth(period).filter((r) => r.inLatestSnapshot)) {
            const key = periodKey(period);
            const month = counts.get(key) ?? {};
            month[row.status] = (month[row.status] ?? 0) + 1;
            counts.set(key, month);
          }
        }
        return counts;
      },
    ),
    linkedRecordIds: vi.fn(
      async (ids: number[]): Promise<Set<number>> =>
        new Set(
          seed.rows
            .map((r) => r.suspensionRecordId)
            .filter((id): id is number => id !== null && ids.includes(id)),
        ),
    ),
    statusesByMember: vi.fn(
      async (
        period: Period,
        memberIds: string[],
      ): Promise<Map<string, WorkspaceStatus>> =>
        new Map(
          inMonth(period)
            .filter((r) => memberIds.includes(r.memberId))
            .map((r) => [r.memberId, r.status]),
        ),
    ),
    statusesForMember: vi.fn(
      async (memberId: string): Promise<Map<string, WorkspaceStatus>> =>
        new Map(
          seed.rows
            .filter((r) => r.memberId === memberId)
            .sort((a, b) => comparePeriods(b.period, a.period))
            .map((r) => [periodKey(r.period), r.status]),
        ),
    ),
  } satisfies WorkspacePageReader;
}

/** Workspace actions that always succeed: perform answers done, sync answers synced. */
export function fakeWorkspaceActions() {
  return {
    perform: vi.fn(async (): Promise<WorkspaceActionResult> => ({
      code: 'done',
    })),
    sync: vi.fn(async (): Promise<WorkspaceSyncCode> => 'synced'),
    moderationLog: vi.fn(async (): Promise<unknown> => true),
  } satisfies WorkspaceActions;
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
    suspensions: async () =>
      fakeSuspensions({
        active: [suspensionRow()],
        past: [
          suspensionRow({ suspendedAt: new Date('2026-08-01T00:00:00Z') }),
        ],
        voided: [
          suspensionRow({
            voidedAt: new Date('2026-09-02T17:00:00Z'),
            voidedBy: '123456789012345678',
            voidReason: 'recorded twice',
          }),
        ],
      }),
    // The access matrix asks for change 1's old thumb: a 1x1 PNG.
    identity: async () =>
      fakeIdentity([identityChange({ id: '1' })], { '1:old': PNG_1X1 }),
    linkProgress: async () => fakeLinkProgress(),
    memberLinks: async () => fakeMemberLinks(),
    workspace: async () => fakeWorkspace(),
    workspaceActions: fakeWorkspaceActions(),
    upcoming: vi.fn(
      async (_memberIds: string[]): Promise<Map<string, UpcomingEntry>> =>
        new Map(),
    ),
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

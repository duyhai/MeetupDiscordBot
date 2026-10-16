import { vi } from 'vitest';

import { LogEntry } from '../../../src/lib/helpers/discordLogger.js';
import { BuildJobDeps } from '../../../src/lib/reports/buildJob.js';
import { LinkProgressCounts } from '../../../src/lib/reports/linkProgress.js';
import { MonthReports } from '../../../src/lib/reports/monthReports.js';
import { Period, periodKey } from '../../../src/lib/reports/period.js';
import {
  AttendanceEvidence,
  HallOfFamePayload,
  NoShowPayload,
  ReportType,
} from '../../../src/lib/reports/types.js';
import {
  SnapshotMeta,
  SnapshotWrite,
} from '../../../src/lib/repositories/postgresReportSnapshotRepository.js';
import { FakeCache } from '../../web/fakeCache.js';

export const HOF_SUMMARY = { events: 4, hosts: 3, newHosts: 1 };
export const NO_SHOW_SUMMARY = {
  noShows: 8,
  members: 7,
  warnings: 2,
  suspensionCandidates: 3,
  cleared: 1,
  departed: 1,
};
export const ATTENDANCE: AttendanceEvidence = {
  pastEventsWithRsvps: 6,
  eventsWithNoShow: 5,
  noShows: 8,
};

/** Small payloads with the fixture summaries; attendance overridable. */
export function monthReports(
  period: Period,
  attendance: AttendanceEvidence = ATTENDANCE,
): MonthReports {
  const hallOfFame: HallOfFamePayload = {
    version: 1,
    reportType: 'hall_of_fame',
    period: periodKey(period),
    asOf: '2026-10-01T07:00:00.000Z',
    summary: { ...HOF_SUMMARY },
    totalEvents: 4,
    hosts: [],
  };
  const noShow: NoShowPayload = {
    version: 1,
    reportType: 'no_show',
    period: periodKey(period),
    asOf: '2026-10-01T07:00:00.000Z',
    summary: { ...NO_SHOW_SUMMARY },
    attendance: { ...attendance },
    cases: [],
    cleared: [],
    departed: [],
  };
  return { hallOfFame, noShow, sourceComplete: true };
}

const same = (a: Period, b: Period) => a.year === b.year && a.month === b.month;

export class FakeSnapshotStore {
  readonly rows: SnapshotWrite[] = [];

  private readonly metas: SnapshotMeta[] = [];

  async save(write: SnapshotWrite): Promise<SnapshotMeta> {
    this.rows.push(write);
    const meta: SnapshotMeta = {
      id: this.metas.length + 1,
      reportType: write.reportType,
      period: write.period,
      builtAt: write.builtAt,
      builtBy: write.builtBy,
      sourceComplete: write.sourceComplete,
      summary: write.payload.summary,
    };
    this.metas.push(meta);
    return meta;
  }

  async getCurrentMeta(
    reportType: ReportType,
    period: Period,
  ): Promise<SnapshotMeta | undefined> {
    const found = this.metas.filter(
      (m) => m.reportType === reportType && same(m.period, period),
    );
    return found[found.length - 1];
  }

  /** A row written before the test (not recorded in `rows`). */
  seed(
    reportType: ReportType,
    period: Period,
    builtAtIso: string,
    options: {
      builtBy?: string;
      sourceComplete?: boolean;
      summary?: unknown;
    } = {},
  ): void {
    this.metas.push({
      id: this.metas.length + 1,
      reportType,
      period,
      builtAt: new Date(builtAtIso),
      builtBy: options.builtBy ?? 'job',
      sourceComplete: options.sourceComplete ?? true,
      summary:
        options.summary ??
        (reportType === 'hall_of_fame' ? HOF_SUMMARY : NO_SHOW_SUMMARY),
    });
  }

  /** Both types of a month. */
  seedBoth(
    period: Period,
    builtAtIso: string,
    options: { builtBy?: string; sourceComplete?: boolean } = {},
  ): void {
    this.seed('hall_of_fame', period, builtAtIso, options);
    this.seed('no_show', period, builtAtIso, options);
  }
}

export class FakeNoticeStore {
  readonly markers = new Set<string>();

  readonly claim = vi.fn(async (kind: string, period: Period) => {
    const key = `${kind}:${periodKey(period)}`;
    if (this.markers.has(key)) {
      return false;
    }
    this.markers.add(key);
    return true;
  });

  readonly release = vi.fn(async (kind: string, period: Period) => {
    this.markers.delete(`${kind}:${periodKey(period)}`);
  });
}

export class FakeLinkProgressStore {
  readonly days = new Map<string, LinkProgressCounts>();

  async hasDay(day: string): Promise<boolean> {
    return this.days.has(day);
  }

  async upsertDay(day: string, counts: LinkProgressCounts): Promise<void> {
    this.days.set(day, counts);
  }
}

export const LINK_COUNTS: LinkProgressCounts = {
  linked: 10,
  unlinked: 5,
  reverifyTagged: 2,
  onboarding: 1,
};

export class Clock {
  private current: Date;

  constructor(iso: string) {
    this.current = new Date(iso);
  }

  set(iso: string): void {
    this.current = new Date(iso);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }
}

/** FakeCache whose TTLs expire on the harness clock, as Redis keys would. */
export class ExpiringCache extends FakeCache {
  private readonly expiries = new Map<string, number>();

  constructor(private readonly clock: Clock) {
    super();
  }

  private expire(key: string): void {
    const at = this.expiries.get(key);
    if (at !== undefined && this.clock.now().getTime() >= at) {
      this.values.delete(key);
      this.ttls.delete(key);
      this.expiries.delete(key);
    }
  }

  override async get(key: string) {
    this.expire(key);
    return super.get(key);
  }

  override async set(key: string, value: string, ttlSec?: number) {
    await super.set(key, value, ttlSec);
    if (ttlSec === undefined) {
      this.expiries.delete(key);
    } else {
      this.expiries.set(key, this.clock.now().getTime() + ttlSec * 1000);
    }
  }

  override async exclusive_set(key: string, value: string, ttlSec?: number) {
    this.expire(key);
    return super.exclusive_set(key, value, ttlSec);
  }

  override async remove(key: string) {
    this.expiries.delete(key);
    await super.remove(key);
  }
}

export interface Harness {
  deps: BuildJobDeps;
  clock: Clock;
  cache: FakeCache;
  snapshots: FakeSnapshotStore;
  notices: FakeNoticeStore;
  linkProgress: FakeLinkProgressStore;
  fetchMonthReports: ReturnType<
    typeof vi.fn<
      (
        period: Period,
        asOf: Date,
        cutoff: Date | undefined,
      ) => Promise<MonthReports>
    >
  >;
  collectLinkProgress: ReturnType<
    typeof vi.fn<() => Promise<LinkProgressCounts>>
  >;
  alert: ReturnType<typeof vi.fn<(entry: LogEntry) => Promise<boolean>>>;
  postRoleNotice: ReturnType<
    typeof vi.fn<
      (
        roleIds: readonly string[],
        content: string,
        entry: LogEntry,
      ) => Promise<boolean>
    >
  >;
  cacheSpy: ReturnType<typeof vi.fn<() => Promise<FakeCache>>>;
}

export interface HarnessOptions {
  clock?: Clock;
  cache?: FakeCache;
  snapshots?: FakeSnapshotStore;
  notices?: FakeNoticeStore;
  linkProgress?: FakeLinkProgressStore;
  reportReadyEnabled?: boolean;
}

export function makeDeps(options: HarnessOptions = {}): Harness {
  const clock = options.clock ?? new Clock('2026-10-05T16:15:00Z');
  const cache = options.cache ?? new ExpiringCache(clock);
  const snapshots = options.snapshots ?? new FakeSnapshotStore();
  const notices = options.notices ?? new FakeNoticeStore();
  const linkProgress = options.linkProgress ?? new FakeLinkProgressStore();
  let leases = 0;
  const fetchMonthReports = vi.fn(
    (period: Period, _asOf: Date, _cutoff: Date | undefined) =>
      Promise.resolve(monthReports(period)),
  );
  const collectLinkProgress = vi.fn(() => Promise.resolve({ ...LINK_COUNTS }));
  const alert = vi.fn((_entry: LogEntry) => Promise.resolve(true));
  const postRoleNotice = vi.fn(
    (_roleIds: readonly string[], _content: string, _entry: LogEntry) =>
      Promise.resolve(true),
  );
  const cacheSpy = vi.fn(() => Promise.resolve(cache));
  const deps: BuildJobDeps = {
    now: () => clock.now(),
    cache: cacheSpy,
    snapshots,
    notices,
    linkProgress,
    fetchMonthReports,
    collectLinkProgress,
    alert,
    postRoleNotice,
    reportReadyEnabled: () => options.reportReadyEnabled ?? true,
    newLeaseValue: () => {
      leases += 1;
      return `lease-${leases}`;
    },
  };
  return {
    deps,
    clock,
    cache,
    snapshots,
    notices,
    linkProgress,
    fetchMonthReports,
    collectLinkProgress,
    alert,
    postRoleNotice,
    cacheSpy,
  };
}

import nock from 'nock';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import { buildMonth } from '../../../src/lib/reports/buildJob.js';
import { buildMonthReports } from '../../../src/lib/reports/monthReports.js';
import { Period } from '../../../src/lib/reports/period.js';
import { syncWorkspace } from '../../../src/lib/workspace/service.js';
import { casesFromPayload } from '../../../src/lib/workspace/sync.js';
import { SyncCase } from '../../../src/lib/workspace/types.js';
import { fakeSuspensionRepository } from '../../fixtures/meetup/fakeSuspensions.js';
import { installMeetupResponder } from '../../fixtures/meetup/graphqlResponder.js';
import {
  SUSPENSIONS_2026,
  WORLD_2026,
} from '../../fixtures/meetup/world2026.js';
import { makeDeps } from '../reports/buildJobFakes.js';

// The build's client bypasses the request cache; fail loudly if anything reaches it.
vi.mock('../../../src/util/cache.js', () => ({
  ApplicationCache: vi.fn(() => {
    throw new Error('the build must not use the request cache');
  }),
}));

afterEach(() => {
  nock.cleanAll();
});

const SEPT: Period = { year: 2026, month: 9 };

/**
 * September 2026 built as the backfill builds it (buildMonth with the real
 * report services over the fixture world), then read back as Postgres JSONB
 * gives it: a JSON round trip.
 */
async function backfilledSeptember() {
  installMeetupResponder(WORLD_2026, { maxPageSize: 2 });
  const h = makeDeps();
  h.deps.fetchMonthReports = (period, asOf, cutoff) =>
    buildMonthReports(
      new GqlMeetupClient('test-token', { bypassCache: true }),
      period,
      {
        asOf,
        suspensionCutoff: cutoff,
        groupId: WORLD_2026.groupId,
        suspensions: fakeSuspensionRepository(SUSPENSIONS_2026),
      },
    );
  await buildMonth(h.deps, SEPT, 'backfill');
  const write = h.snapshots.rows.find((r) => r.reportType === 'no_show');
  const meta = await h.snapshots.getCurrentMeta('no_show', SEPT);
  return {
    payload: JSON.parse(JSON.stringify(write?.payload)) as unknown,
    meta,
  };
}

describe('a backfilled no-show payload syncs', () => {
  it('casesFromPayload accepts the payload the build saves, every case included', async () => {
    const { payload } = await backfilledSeptember();
    const stored = payload as {
      cases: { member: { id: string; name: string }; classification: string }[];
    };
    expect(stored.cases.length).toBeGreaterThan(0);
    expect(new Set(stored.cases.map((c) => c.classification))).toEqual(
      new Set(['warning', 'suspension']),
    );
    expect(casesFromPayload(payload)).toEqual(
      stored.cases.map((c): SyncCase => ({
        memberId: c.member.id,
        memberName: c.member.name,
        classification: c.classification as SyncCase['classification'],
      })),
    );
  });

  it('syncWorkspace hands those cases to the repository', async () => {
    const { payload, meta } = await backfilledSeptember();
    const syncFromSnapshot = vi.fn(async (_input: { cases: SyncCase[] }) => ({
      status: 'synced' as const,
      created: 0,
      reclassified: 0,
      dropped: 0,
      returned: 0,
    }));
    const code = await syncWorkspace(
      {
        now: () => new Date('2026-10-17T16:15:00Z'),
        repository: async () => ({
          syncFromSnapshot,
          monthState: async () => undefined,
        }),
        snapshots: async () => ({
          getCurrentMeta: async () => meta,
          getCurrent: async () =>
            ({ id: meta?.id, builtAt: meta?.builtAt, payload }) as never,
        }),
      },
      SEPT,
    );
    expect(code).toBe('synced');
    expect(syncFromSnapshot).toHaveBeenCalledWith({
      period: SEPT,
      snapshotId: meta?.id,
      snapshotBuiltAt: meta?.builtAt,
      cases: casesFromPayload(payload),
    });
    expect(syncFromSnapshot.mock.calls[0][0].cases.length).toBeGreaterThan(0);
  });
});

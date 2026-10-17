import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toEventRef, toMemberRef } from '../../src/lib/reports/types.js';
import { dashboardPool } from '../../src/lib/repositories/dashboardPool.js';
import { PostgresReportSnapshotRepository } from '../../src/lib/repositories/postgresReportSnapshotRepository.js';
import { useIsolatedSchema } from './isolatedSchema.js';

// Requires DATABASE_URL against a throwaway Postgres; skipped otherwise.
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

const NUL = String.fromCharCode(0);

describe.skipIf(!POSTGRES_AVAILABLE)('a member name with U+0000', () => {
  let schema: { drop(): Promise<void> } | undefined;

  // Its own schema: report_snapshots here is not the one other files truncate.
  beforeAll(async () => {
    schema = await useIsolatedSchema('nul_test');
  });

  afterAll(async () => {
    await (await dashboardPool()).end();
    await schema?.drop();
  });

  it('saves: the refs strip it before the JSONB write', async () => {
    const repo = await PostgresReportSnapshotRepository.instance();
    const host = toMemberRef({
      id: '901',
      name: `Nul${NUL}Name ‏مريم 🍜`,
      memberUrl: 'https://www.meetup.com/members/901/',
    });
    const event = toEventRef({
      id: 'e901',
      title: `Event${NUL} 👩🏽‍💻`,
      eventUrl: 'https://www.meetup.com/g/events/901/',
      dateTime: '2013-04-03T19:00-07:00',
    });
    const meta = await repo.save({
      reportType: 'hall_of_fame',
      period: { year: 2013, month: 4 },
      builtAt: new Date('2013-05-02T16:00:00Z'),
      builtBy: 'backfill',
      sourceComplete: true,
      mode: 'supersede',
      payload: {
        version: 1,
        reportType: 'hall_of_fame',
        period: '2013-04',
        asOf: '2013-05-01T07:00:00.000Z',
        summary: { events: 1, hosts: 1, newHosts: 1 },
        totalEvents: 1,
        hosts: [
          {
            host,
            isNew: true,
            events: [{ ...event, attendance: 3, maxTickets: 10 }],
          },
        ],
      } as never,
    });
    expect(meta.id).toBeGreaterThan(0);
    expect(host.name).toBe('NulName ‏مريم 🍜');
    expect(event.title).toBe('Event 👩🏽‍💻');
  });
});

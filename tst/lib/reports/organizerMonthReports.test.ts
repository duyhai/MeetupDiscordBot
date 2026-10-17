import { Client } from 'discord.js';
import { ClientError } from 'graphql-request';
import { describe, expect, it, vi } from 'vitest';

import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import { organizerMonthReports } from '../../../src/lib/reports/buildJob.js';
import { buildMonthReports } from '../../../src/lib/reports/monthReports.js';
import {
  defaultOrganizerMeetupDeps,
  OrganizerMeetupDeps,
  OrganizerTokenUnavailableError,
} from '../../../src/lib/reports/organizerMeetup.js';
import { monthReports } from './buildJobFakes.js';

vi.mock('../../../src/lib/reports/monthReports.js', () => ({
  buildMonthReports: vi.fn(),
}));

const SEPT = { year: 2026, month: 9 };
const ASOF = new Date('2026-10-01T07:00:00Z');
const CUTOFF = new Date('2026-10-01T00:00:00Z');
const suspensions = { listByMemberIds: vi.fn() };

const unauthorized = () =>
  new ClientError(
    { status: 401, headers: new Headers(), body: 'raw body' },
    { query: '' },
  );

function organizer(tokens: (string | undefined)[]) {
  const getToken = vi.fn();
  tokens.forEach((t) => getToken.mockResolvedValueOnce(t));
  const makeClient = vi.fn(
    (token: string) => ({ token }) as unknown as GqlMeetupClient,
  );
  const deps = { getToken, makeClient } as unknown as OrganizerMeetupDeps;
  return { deps, getToken, makeClient };
}

describe('organizerMonthReports', () => {
  it('reads the month with the organizer token and the build inputs', async () => {
    const reports = monthReports(SEPT);
    vi.mocked(buildMonthReports).mockReset().mockResolvedValue(reports);
    const o = organizer(['tok-1']);
    const fetch = organizerMonthReports(undefined, suspensions, o.deps);
    expect(await fetch(SEPT, ASOF, CUTOFF)).toBe(reports);
    // No Discord client in the backfill: the token helper sends no alerts.
    expect(o.getToken).toHaveBeenCalledWith({ client: undefined });
    expect(o.makeClient).toHaveBeenCalledWith('tok-1');
    expect(buildMonthReports).toHaveBeenCalledWith({ token: 'tok-1' }, SEPT, {
      asOf: ASOF,
      suspensionCutoff: CUTOFF,
      groupId: '7595882',
      suspensions,
    });
  });

  it('a 401 gets one forced refresh and re-runs the whole read', async () => {
    const reports = monthReports(SEPT);
    vi.mocked(buildMonthReports)
      .mockReset()
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValueOnce(reports);
    const o = organizer(['old', 'new']);
    const discord = {} as Client;
    const fetch = organizerMonthReports(discord, suspensions, o.deps);
    expect(await fetch(SEPT, ASOF, CUTOFF)).toBe(reports);
    expect(o.getToken).toHaveBeenNthCalledWith(2, {
      forceRefresh: true,
      refusedAccessToken: 'old',
      client: discord,
    });
    expect(vi.mocked(buildMonthReports).mock.calls.map((c) => c[0])).toEqual([
      { token: 'old' },
      { token: 'new' },
    ]);
  });

  it('a second 401 propagates; no token is a fixed error', async () => {
    vi.mocked(buildMonthReports).mockReset().mockRejectedValue(unauthorized());
    const twice = organizer(['old', 'new']);
    await expect(
      organizerMonthReports(undefined, suspensions, twice.deps)(
        SEPT,
        ASOF,
        CUTOFF,
      ),
    ).rejects.toBeInstanceOf(ClientError);
    expect(twice.getToken).toHaveBeenCalledTimes(2);
    const none = organizer([undefined]);
    await expect(
      organizerMonthReports(undefined, suspensions, none.deps)(
        SEPT,
        ASOF,
        CUTOFF,
      ),
    ).rejects.toBeInstanceOf(OrganizerTokenUnavailableError);
  });

  it('defaults to the uncached organizer client', () => {
    const made = defaultOrganizerMeetupDeps.makeClient('t');
    expect(made).toBeInstanceOf(GqlMeetupClient);
    expect((made as unknown as { bypassCache: boolean }).bypassCache).toBe(
      true,
    );
  });
});

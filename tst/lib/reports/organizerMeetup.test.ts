/* eslint-disable
  @typescript-eslint/no-explicit-any,
  @typescript-eslint/no-unsafe-member-access
*/
import { Client } from 'discord.js';
import { ClientError } from 'graphql-request';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Configuration from '../../../src/configuration.js';
import { GqlMeetupClient } from '../../../src/lib/client/meetup/gqlClient.js';
import {
  OrganizerMeetupDeps,
  defaultOrganizerMeetupDeps,
  OrganizerTokenUnavailableError,
  withOrganizerMeetup,
} from '../../../src/lib/reports/organizerMeetup.js';
import { ApplicationCache } from '../../../src/util/cache.js';

vi.mock('../../../src/util/cache.js', () => ({
  ApplicationCache: vi.fn(async () => ({
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  })),
}));

const clientError = (status: number) =>
  new ClientError(
    { status, headers: new Headers(), body: 'raw meetup body' },
    { query: '' },
  );

const discord = { id: 'discord-client' } as unknown as Client;

interface Fakes {
  deps: OrganizerMeetupDeps;
  getToken: ReturnType<typeof vi.fn>;
  makeClient: ReturnType<typeof vi.fn>;
}

function fakes(tokens: (string | undefined)[]): Fakes {
  const getToken = vi.fn();
  tokens.forEach((t) => getToken.mockResolvedValueOnce(t));
  const makeClient = vi.fn(
    (token: string) => ({ token }) as unknown as GqlMeetupClient,
  );
  return {
    deps: { getToken, makeClient },
    getToken,
    makeClient,
  };
}

describe('withOrganizerMeetup', () => {
  afterEach(() => {
    nock.cleanAll();
    vi.clearAllMocks();
  });

  it('uses the organizer token from getToken({ client })', async () => {
    const f = fakes(['tok-1']);
    const result = await withOrganizerMeetup(
      discord,
      async (m: any) => m.token as string,
      f.deps,
    );
    expect(result).toBe('tok-1');
    expect(f.getToken).toHaveBeenCalledTimes(1);
    expect(f.getToken).toHaveBeenCalledWith({ client: discord });
    expect(f.makeClient).toHaveBeenCalledWith('tok-1');
  });

  it('the default factory builds an uncached client', async () => {
    const endpoint = new URL(Configuration.meetup.endpoint);
    nock(endpoint.origin)
      .post(endpoint.pathname)
      .reply(200, {
        data: {
          event: {
            id: 'e1',
            rsvps: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [],
            },
          },
        },
      });
    const meetup = defaultOrganizerMeetupDeps.makeClient('tok-default');
    await meetup.getEventRsvps('e1', { first: 100 });
    expect(ApplicationCache).not.toHaveBeenCalled();
  });

  it('retries once with a forced refresh after a 401, naming the refused token', async () => {
    const f = fakes(['tok-1', 'tok-2']);
    const fn = vi.fn(async (m: any) => {
      if (m.token === 'tok-1') {
        throw clientError(401);
      }
      return m.token as string;
    });

    const result = await withOrganizerMeetup(discord, fn, f.deps);

    expect(result).toBe('tok-2');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(f.getToken).toHaveBeenNthCalledWith(2, {
      forceRefresh: true,
      refusedAccessToken: 'tok-1',
      client: discord,
    });
  });

  it('a second 401 propagates', async () => {
    const f = fakes(['tok-1', 'tok-2']);
    const second = clientError(401);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(clientError(401))
      .mockRejectedValueOnce(second);

    await expect(withOrganizerMeetup(discord, fn, f.deps)).rejects.toBe(second);
    expect(f.getToken).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('no token: throws a safe error and never calls Meetup', async () => {
    const f = fakes([undefined]);
    const fn = vi.fn();

    const error = await withOrganizerMeetup(discord, fn, f.deps).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(OrganizerTokenUnavailableError);
    expect((error as OrganizerTokenUnavailableError).organizerSafeMessage).toBe(
      true,
    );
    expect((error as Error).message).toContain('/dashboard/organizer-login');
    expect(fn).not.toHaveBeenCalled();
    expect(f.makeClient).not.toHaveBeenCalled();
  });

  it('a forced refresh that yields nothing throws OrganizerTokenUnavailableError', async () => {
    const f = fakes(['tok-1', undefined]);
    const fn = vi.fn().mockRejectedValue(clientError(401));

    await expect(
      withOrganizerMeetup(discord, fn, f.deps),
    ).rejects.toBeInstanceOf(OrganizerTokenUnavailableError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('other errors are not retried', async () => {
    const f = fakes(['tok-1', 'tok-2']);
    const boom = clientError(500);
    const fn = vi.fn().mockRejectedValue(boom);

    await expect(withOrganizerMeetup(discord, fn, f.deps)).rejects.toBe(boom);
    expect(f.getToken).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });
});

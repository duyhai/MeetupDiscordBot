import { ClientError } from 'graphql-request';
import { describe, expect, it, vi } from 'vitest';

import {
  GqlMeetupClient,
  withoutResponseData,
} from '../../../../src/lib/client/meetup/gqlClient.js';

/** What Meetup could send: an error alongside partial listing data. */
const leaky = () =>
  new ClientError(
    {
      status: 200,
      headers: new Headers(),
      errors: [
        { message: 'Some field failed', path: ['groupByUrlname'] },
      ] as unknown as ClientError['response']['errors'],
      data: {
        groupByUrlname: {
          events: {
            edges: [
              {
                node: {
                  venue: { lat: 47.612345, lon: -122.334567 },
                  eventHosts: [{ member: { id: '1', name: 'Secret Host' } }],
                },
              },
            ],
          },
        },
      },
      body: '{"venue":{"lat":47.612345}}',
    },
    { query: 'query { secret }', variables: { urlname: 'g' } },
  );

describe('withoutResponseData', () => {
  it('keeps the status and GraphQL messages; drops data, body and query', () => {
    const clean = withoutResponseData(leaky(), 'getGroupEventsForSnapshot');
    expect(clean).toBeInstanceOf(ClientError);
    const e = clean as ClientError;
    expect(e.response.status).toBe(200);
    expect(e.response.errors?.[0]?.message).toBe('Some field failed');
    for (const text of [e.message, JSON.stringify(e.response)]) {
      expect(text).not.toContain('47.61');
      expect(text).not.toContain('Secret Host');
      expect(text).not.toContain('query { secret }');
    }
  });

  it('keeps a 401 and a 429 recognisable', () => {
    const status = (s: number) =>
      (
        withoutResponseData(
          new ClientError(
            { status: s, headers: new Headers() } as ClientError['response'],
            { query: 'q' },
          ),
          'op',
        ) as ClientError
      ).response.status;
    expect(status(401)).toBe(401);
    expect(status(429)).toBe(429);
  });

  it('passes anything else through', () => {
    const other = new RangeError('x');
    expect(withoutResponseData(other, 'op')).toBe(other);
  });

  it('the snapshot listing rethrows the stripped error', async () => {
    const client = new GqlMeetupClient('token');
    const inner = (client as unknown as { client: { request: () => unknown } })
      .client;
    vi.spyOn(inner, 'request').mockRejectedValue(leaky());
    const error = await client
      .getGroupEventsForSnapshot({ first: 100 }, { status: ['PAST'] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    expect((error as Error).message).not.toContain('47.61');
    expect((error as Error).message).not.toContain('Secret Host');
  });
});

import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Configuration from '../../../../src/configuration.js';
import { GqlMeetupClient } from '../../../../src/lib/client/meetup/gqlClient.js';

const fake = vi.hoisted(() => ({ logged: [] as string[] }));

// Captures everything the client logs, rendered the way tslog would show it.
vi.mock('tslog', () => {
  const renderOne = (arg: unknown) => {
    if (arg instanceof Error) {
      return `${arg.message} ${arg.stack ?? ''}`;
    }
    return typeof arg === 'string' ? arg : JSON.stringify(arg);
  };
  const render = (args: unknown[]) => args.map(renderOne).join(' ');
  class Logger {
    debug = (...args: unknown[]) => fake.logged.push(render(args));

    info = (...args: unknown[]) => fake.logged.push(render(args));

    warn = (...args: unknown[]) => fake.logged.push(render(args));

    error = (...args: unknown[]) => fake.logged.push(render(args));
  }
  return { Logger };
});

const ENDPOINT = new URL(Configuration.meetup.endpoint);

function graphqlScope() {
  return nock(ENDPOINT.origin).post(ENDPOINT.pathname);
}

describe('GqlMeetupClient.getSelfId', () => {
  beforeEach(() => {
    fake.logged.length = 0;
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('asks only for the id and logs nothing about the result', async () => {
    let sentQuery = '';
    const scope = graphqlScope()
      .matchHeader('authorization', 'Bearer test-access-token')
      .reply(200, (_uri, body: { query: string }) => {
        sentQuery = body.query;
        return { data: { self: { id: '468174923' } } };
      });

    await expect(
      new GqlMeetupClient('test-access-token').getSelfId(),
    ).resolves.toBe('468174923');
    expect(scope.isDone()).toBe(true);
    expect(sentQuery.replace(/\s+/g, ' ').trim()).toBe('query { self { id } }');
    expect(fake.logged.join('\n')).not.toContain('468174923');
  });

  it('refuses an id that is not all digits', async () => {
    graphqlScope().reply(200, { data: { self: { id: '12a<b>' } } });

    await expect(
      new GqlMeetupClient('test-access-token').getSelfId(),
    ).rejects.toThrow('Meetup returned no usable member id');
    expect(fake.logged.join('\n')).not.toContain('12a<b>');
  });

  it('refuses a missing self', async () => {
    graphqlScope().reply(200, { data: { self: null } });

    await expect(
      new GqlMeetupClient('test-access-token').getSelfId(),
    ).rejects.toThrow('Meetup returned no usable member id');
  });

  it('logs a failure by name only, never the response body', async () => {
    graphqlScope().reply(401, { errors: [{ message: 'RAW-BODY-SECRET' }] });

    await expect(
      new GqlMeetupClient('test-access-token').getSelfId(),
    ).rejects.toThrow();
    const logged = fake.logged.join('\n');
    expect(logged).toContain('ClientError HTTP 401');
    expect(logged).not.toContain('RAW-BODY-SECRET');
  });
});

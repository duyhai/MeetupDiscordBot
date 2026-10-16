import dayjs from 'dayjs';
import { ClientError } from 'graphql-request';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Configuration from '../../src/configuration.js';
import { getOrganizerAccessToken } from '../../src/lib/helpers/organizerMeetupClient.js';
import { tz } from '../../src/util/timezone.js';
import { main, reportFatal } from '../../scripts/checkOrganizerVisibility.js';

const fake = vi.hoisted(() => ({
  request: vi.fn(),
  constructed: [] as { endpoint: string; headers: unknown }[],
}));

vi.mock('graphql-request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('graphql-request')>();
  class GraphQLClient {
    constructor(endpoint: string, options: { headers: unknown }) {
      fake.constructed.push({ endpoint, headers: options.headers });
    }

    request = fake.request;
  }
  return { ...actual, GraphQLClient };
});

vi.mock('../../src/lib/helpers/organizerMeetupClient.js', () => ({
  getOrganizerAccessToken: vi.fn(),
}));

const MEMBER_NAME = 'Zaphod Beeblebrox';
const EVENT_ID = '314159';
const EVENT_TIME = dayjs().subtract(5, 'day').toISOString();
const YOUNG_TIME = dayjs().subtract(1, 'day').toISOString();
const EVENT_DATE = tz(dayjs(EVENT_TIME)).format('YYYY-MM-DD');

type Vars = Record<string, unknown>;

function namedEvent(id: string, dateTime: string) {
  return { node: { id, dateTime, title: `${MEMBER_NAME}'s meetup` } };
}

function edges(status: string, n: number) {
  return Array.from({ length: n }, () => ({
    node: { status, member: { name: MEMBER_NAME } },
  }));
}

interface Fixture {
  self?: { id: string };
  events?: ReturnType<typeof namedEvent>[];
  eventsHasNext?: boolean;
  rsvps?: (status: string) => unknown;
}

function serve(fixture: Fixture = {}) {
  fake.request.mockImplementation(async (_query: string, vars: Vars = {}) => {
    if ('urlname' in vars) {
      return {
        groupByUrlname: {
          events: {
            pageInfo: { hasNextPage: fixture.eventsHasNext ?? false },
            edges: fixture.events ?? [namedEvent(EVENT_ID, EVENT_TIME)],
          },
        },
      };
    }
    if ('eventId' in vars) {
      const [status] = (vars.filter as { rsvpStatus: string[] }).rsvpStatus;
      return {
        event: {
          rsvps: fixture.rsvps
            ? fixture.rsvps(status)
            : {
                totalCount: 1,
                pageInfo: { hasNextPage: false },
                edges: edges(status, 1),
              },
        },
      };
    }
    return { self: fixture.self ?? { id: '468174923' } };
  });
}

describe('checkOrganizerVisibility', () => {
  let stdout: string[];
  let stderr: string[];
  let organizerMemberId: string | undefined;
  let realStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    fake.request.mockReset();
    fake.constructed.length = 0;
    vi.mocked(getOrganizerAccessToken).mockReset();
    vi.mocked(getOrganizerAccessToken).mockResolvedValue('t');
    organizerMemberId = Configuration.meetup.organizerMemberId;
    Configuration.meetup.organizerMemberId = '468174923';
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (chunk: string | Uint8Array) => {
        stdout.push(String(chunk));
        return true;
      },
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(
      (chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      },
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    realStdoutWrite = process.stdout.write;
  });

  afterEach(() => {
    Configuration.meetup.organizerMemberId = organizerMemberId;
    vi.restoreAllMocks();
  });

  it('prints counts only', async () => {
    vi.mocked(getOrganizerAccessToken).mockImplementation(async () => {
      // The helper logs through tslog to stdout/stderr, and its messages can
      // carry anything: none of it may reach the output.
      process.stdout.write(`helper chatter ${MEMBER_NAME}\n`);
      process.stderr.write(`helper chatter ${MEMBER_NAME}\n`);
      return 'secret-token';
    });
    serve({
      self: { id: '468174923' },
      events: [
        namedEvent('1', dayjs().subtract(20, 'day').toISOString()),
        namedEvent(EVENT_ID, EVENT_TIME),
      ],
      rsvps: (status) => ({
        totalCount: 99,
        pageInfo: { hasNextPage: false },
        edges: edges(status, status === 'NO_SHOW' ? 3 : 17),
      }),
    });

    expect(await main([])).toBe(0);

    expect(stdout.join('')).toBe(
      [
        'organizer account matches MEETUP_ORGANIZER_MEMBER_ID: yes',
        `event: ${EVENT_ID} (${EVENT_DATE})`,
        'NO_SHOW rsvps visible: 3',
        'ATTENDED rsvps visible: 17',
        '',
      ].join('\n'),
    );
    const all = stdout.join('') + stderr.join('');
    expect(all).not.toContain(MEMBER_NAME);
    expect(all).not.toContain('secret-token');
    expect(getOrganizerAccessToken).toHaveBeenCalledWith();
    expect(fake.constructed[0].headers).toEqual({
      authorization: 'Bearer secret-token',
    });
  });

  it('counts edges like production', async () => {
    serve({
      rsvps: (status) => {
        if (status === 'NO_SHOW') {
          return {
            totalCount: 500,
            pageInfo: { hasNextPage: true },
            edges: edges('NO_SHOW', 100),
          };
        }
        return {
          totalCount: 7,
          pageInfo: { hasNextPage: false },
          edges: edges('ATTENDED', 4),
        };
      },
    });

    expect(await main([])).toBe(0);
    expect(stdout.join('')).toContain(
      'NO_SHOW rsvps visible: 500 (more than 100; totalCount)\n',
    );
    expect(stdout.join('')).toContain('ATTENDED rsvps visible: 4\n');
  });

  it('exits 2 when the filter is not applied', async () => {
    serve({
      rsvps: () => ({
        totalCount: 2,
        pageInfo: { hasNextPage: false },
        edges: edges('YES', 2),
      }),
    });

    expect(await main([])).toBe(2);
    expect(stderr.join('')).toBe('filter not applied: YES\n');
    expect(stdout.join('')).toBe('');
  });

  it('uses --event when given', async () => {
    serve();

    expect(await main(['--', '--event', '777'])).toBe(0);
    const queries = fake.request.mock.calls.map((c) => (c[1] ?? {}) as Vars);
    expect(queries.some((v) => 'urlname' in v)).toBe(false);
    expect(
      queries.filter((v) => 'eventId' in v).every((v) => v.eventId === '777'),
    ).toBe(true);
    expect(stdout.join('')).toContain('event: 777\n');
  });

  it('rejects a non-numeric --event', async () => {
    serve();

    expect(await main(['--event', '12; drop'])).toBe(1);
    expect(await main(['--event'])).toBe(1);
    expect(stderr.join('')).toBe('invalid --event\ninvalid --event\n');
    expect(stdout.join('')).toBe('');
    expect(fake.request).not.toHaveBeenCalled();
  });

  it('skips events younger than 2 days', async () => {
    serve({
      events: [
        namedEvent('young', YOUNG_TIME),
        namedEvent(EVENT_ID, EVENT_TIME),
      ],
    });

    expect(await main([])).toBe(0);
    expect(stdout.join('')).toContain(`event: ${EVENT_ID} `);
    expect(stdout.join('')).not.toContain('young');
  });

  it('says so when more events matched than one page', async () => {
    serve({ eventsHasNext: true });

    expect(await main([])).toBe(0);
    expect(stderr.join('')).toBe(
      'more than 50 past events in the window; picked the newest of those returned\n',
    );
  });

  it('reports a different or unconfigured organizer account', async () => {
    serve({ self: { id: '999' } });

    expect(await main([])).toBe(0);
    expect(stdout.join('').split('\n')[0]).toBe(
      'organizer account matches MEETUP_ORGANIZER_MEMBER_ID: no',
    );

    stdout.length = 0;
    Configuration.meetup.organizerMemberId = undefined;
    expect(await main([])).toBe(0);
    expect(stdout.join('').split('\n')[0]).toBe(
      'organizer account matches MEETUP_ORGANIZER_MEMBER_ID: not configured',
    );
  });

  it('exits 1 without a token', async () => {
    vi.mocked(getOrganizerAccessToken).mockResolvedValue(undefined);

    expect(await main([])).toBe(1);
    expect(fake.request).not.toHaveBeenCalled();
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toBe('no organizer token\n');
  });

  it('exits 1 when there is no past event', async () => {
    serve({ events: [namedEvent('young', YOUNG_TIME)] });

    expect(await main([])).toBe(1);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toBe('no past event in the last 30 days\n');
  });

  it('exits 2 and prints only the error name when a query fails', async () => {
    serve();
    const body = `body mentions ${MEMBER_NAME}`;
    fake.request.mockImplementation(async (_query: string, vars: Vars = {}) => {
      if ('urlname' in vars) {
        return {
          groupByUrlname: {
            events: {
              pageInfo: { hasNextPage: false },
              edges: [namedEvent(EVENT_ID, EVENT_TIME)],
            },
          },
        };
      }
      if ('eventId' in vars) {
        throw new ClientError(
          { status: 403, errors: [{ message: body }] },
          { query: 'q' },
        );
      }
      return { self: { id: '468174923' } };
    });

    expect(await main([])).toBe(2);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toBe('rsvps: ClientError HTTP 403\n');
    expect(stderr.join('')).not.toContain(MEMBER_NAME);
  });

  it('sends no query that selects a name', async () => {
    serve();

    await main([]);
    const queries = fake.request.mock.calls.map((c) => String(c[0]));
    expect(queries).toHaveLength(4);
    queries.forEach((query) => {
      expect(query).not.toMatch(/\bname\b/);
      expect(query).not.toContain('member {');
    });
  });

  it('restores process.stdout.write after main', async () => {
    serve();
    await main([]);
    expect(Reflect.get(process.stdout, 'write')).toBe(realStdoutWrite);

    vi.mocked(getOrganizerAccessToken).mockRejectedValue(new Error('boom'));
    await expect(main([])).rejects.toThrow('boom');
    expect(Reflect.get(process.stdout, 'write')).toBe(realStdoutWrite);
  });

  it('reportFatal writes only the error type', () => {
    const error = new ClientError(
      { status: 500, errors: [{ message: `body ${MEMBER_NAME}` }] },
      { query: 'q' },
    );
    reportFatal(error);
    reportFatal(new TypeError(`bad ${MEMBER_NAME}`));

    expect(stderr.join('')).toBe(
      'fatal: ClientError HTTP 500\nfatal: TypeError\n',
    );
  });
});

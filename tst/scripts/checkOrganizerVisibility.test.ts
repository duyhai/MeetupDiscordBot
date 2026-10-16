import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Configuration from '../../src/configuration.js';
import { getOrganizerAccessToken } from '../../src/lib/helpers/organizerMeetupClient.js';
import { main } from '../../scripts/checkOrganizerVisibility.js';

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
// 2026-10-10 03:30 UTC is still 2026-10-09 in Pacific.
const EVENT_TIME = '2026-10-10T03:30:00.000Z';

function namedEvent(id: string, dateTime: string) {
  return { node: { id, dateTime, title: `${MEMBER_NAME}'s meetup` } };
}

describe('checkOrganizerVisibility', () => {
  let stdout: string[];
  let stderr: string[];
  let organizerMemberId: string | undefined;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    fake.request.mockReset();
    fake.constructed.length = 0;
    vi.mocked(getOrganizerAccessToken).mockReset();
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
    fake.request.mockImplementation(
      async (_query: string, variables: Record<string, unknown> = {}) => {
        if ('urlname' in variables) {
          return {
            groupByUrlname: {
              events: {
                edges: [
                  namedEvent('1', '2026-09-01T02:00:00.000Z'),
                  namedEvent(EVENT_ID, EVENT_TIME),
                ],
              },
            },
          };
        }
        if ('eventId' in variables) {
          const statuses = (variables.filter as { rsvpStatus: string[] })
            .rsvpStatus;
          return {
            event: {
              rsvps: {
                totalCount: statuses[0] === 'NO_SHOW' ? 3 : 17,
                edges: [{ node: { member: { name: MEMBER_NAME } } }],
              },
            },
          };
        }
        return { self: { id: '468174923', name: MEMBER_NAME } };
      },
    );

    const code = await main();

    expect(code).toBe(0);
    expect(stdout.join('')).toBe(
      [
        'organizer account matches MEETUP_ORGANIZER_MEMBER_ID: yes',
        `event: ${EVENT_ID} (2026-10-09)`,
        'NO_SHOW rsvps visible: 3',
        'ATTENDED rsvps visible: 17',
        '',
      ].join('\n'),
    );
    expect(stdout.join('') + stderr.join('')).not.toContain(MEMBER_NAME);
    expect(stdout.join('') + stderr.join('')).not.toContain('secret-token');
    expect(getOrganizerAccessToken).toHaveBeenCalledWith();
    expect(fake.constructed[0].headers).toEqual({
      authorization: 'Bearer secret-token',
    });
  });

  it('reports a different or unconfigured organizer account', async () => {
    vi.mocked(getOrganizerAccessToken).mockResolvedValue('t');
    fake.request.mockImplementation(
      async (_query: string, variables: Record<string, unknown> = {}) => {
        if ('urlname' in variables) {
          return {
            groupByUrlname: {
              events: { edges: [namedEvent(EVENT_ID, EVENT_TIME)] },
            },
          };
        }
        if ('eventId' in variables) {
          return { event: { rsvps: { totalCount: 0 } } };
        }
        return { self: { id: '999' } };
      },
    );

    expect(await main()).toBe(0);
    expect(stdout.join('').split('\n')[0]).toBe(
      'organizer account matches MEETUP_ORGANIZER_MEMBER_ID: no',
    );

    stdout.length = 0;
    Configuration.meetup.organizerMemberId = undefined;
    expect(await main()).toBe(0);
    expect(stdout.join('').split('\n')[0]).toBe(
      'organizer account matches MEETUP_ORGANIZER_MEMBER_ID: not configured',
    );
  });

  it('exits 1 without a token', async () => {
    vi.mocked(getOrganizerAccessToken).mockResolvedValue(undefined);

    expect(await main()).toBe(1);
    expect(fake.request).not.toHaveBeenCalled();
    expect(stdout.join('')).toBe('');
  });

  it('exits 1 when there is no past event', async () => {
    vi.mocked(getOrganizerAccessToken).mockResolvedValue('t');
    fake.request.mockImplementation(
      async (_query: string, variables: Record<string, unknown> = {}) => {
        if ('urlname' in variables) {
          return { groupByUrlname: { events: { edges: [] } } };
        }
        return { self: { id: '468174923' } };
      },
    );

    expect(await main()).toBe(1);
    expect(stdout.join('')).not.toContain('NO_SHOW');
  });

  it('exits 2 and prints only the error name when a query fails', async () => {
    vi.mocked(getOrganizerAccessToken).mockResolvedValue('t');
    fake.request.mockImplementation(
      async (_query: string, variables: Record<string, unknown> = {}) => {
        if ('urlname' in variables) {
          return {
            groupByUrlname: {
              events: { edges: [namedEvent(EVENT_ID, EVENT_TIME)] },
            },
          };
        }
        if ('eventId' in variables) {
          const error = new Error(`body mentions ${MEMBER_NAME}`);
          error.name = 'ClientError';
          throw error;
        }
        return { self: { id: '468174923' } };
      },
    );

    expect(await main()).toBe(2);
    const output = stdout.join('') + stderr.join('');
    expect(output).toContain('ClientError');
    expect(output).not.toContain(MEMBER_NAME);
    expect(output).not.toContain('body mentions');
  });
});

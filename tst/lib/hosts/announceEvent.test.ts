import { ClientError } from 'graphql-request';
import { describe, expect, it, vi } from 'vitest';

import { MeetupPayloadError } from '../../../src/lib/client/meetup/payloadErrors.js';
import { announceHostEvent } from '../../../src/lib/hosts/announceEvent.js';
import { HostEvent } from '../../../src/lib/hosts/hostEvents.js';
import { OrganizerTokenUnavailableError } from '../../../src/lib/reports/organizerMeetup.js';
import {
  Announcement,
  AnnouncementStatus,
} from '../../../src/lib/repositories/postgresEventAnnouncementRepository.js';

const HOST = { meetupMemberId: '12345', name: 'Dee *Host*' };
const EVENT: HostEvent = {
  id: '311111111',
  title: 'Board games [click](https://evil.example)',
  dateTime: '2026-11-20T19:00:00-08:00',
  eventUrl: 'https://www.meetup.com/g/events/311111111/',
  type: 'games',
  hosts: [{ id: HOST.meetupMemberId, name: HOST.name }],
};

/** The store in memory, with Postgres's one-statement claim. */
function memoryStore(start?: AnnouncementStatus) {
  const rows = new Map<string, Announcement>();
  if (start) {
    rows.set(EVENT.id, {
      meetupEventId: EVENT.id,
      requestedBy: HOST.meetupMemberId,
      status: start,
      failure: null,
      requestedAt: new Date(),
      completedAt: null,
    });
  }
  return {
    rows,
    claim: vi.fn(async (id: string, by: string) => {
      const current = rows.get(id);
      if (
        current === undefined ||
        current.status === 'failed' ||
        current.status === 'unknown'
      ) {
        rows.set(id, {
          meetupEventId: id,
          requestedBy: by,
          status: 'sending',
          failure: null,
          requestedAt: new Date(),
          completedAt: null,
        });
        return { claimed: true as const };
      }
      return { claimed: false as const, current };
    }),
    finish: vi.fn(
      async (
        id: string,
        status: Exclude<AnnouncementStatus, 'sending'>,
        failure: string | null = null,
      ) => {
        const row = rows.get(id);
        if (row?.status === 'sending') {
          rows.set(id, { ...row, status, failure });
        }
      },
    ),
  };
}

function setup(
  options: {
    start?: AnnouncementStatus;
    announce?: () => Promise<void>;
    events?: HostEvent[];
  } = {},
) {
  const store = memoryStore(options.start);
  const deps = {
    announcements: async () => store,
    ownUpcoming: vi.fn(async () => options.events ?? [EVENT]),
    announce: vi.fn(options.announce ?? (async () => undefined)),
    alert: vi.fn().mockResolvedValue(true),
  };
  return { store, deps, run: () => announceHostEvent(deps, HOST, EVENT.id) };
}

const graphqlError = (message: string, status = 200) =>
  new ClientError(
    { status, errors: [{ message }] as never, headers: new Headers() } as never,
    { query: 'mutation' },
  );

describe('announceHostEvent', () => {
  it('sends once, records it, and alerts with the text escaped and no mentions', async () => {
    const { store, deps, run } = setup();
    await expect(run()).resolves.toBe('sent');
    expect(deps.announce).toHaveBeenCalledWith(EVENT.id);
    expect(store.rows.get(EVENT.id)?.status).toBe('sent');
    const alert = JSON.stringify(deps.alert.mock.calls);
    expect(alert).toContain('A host announced an event');
    expect(alert).toContain('Dee \\\\*Host\\\\*');
    // The masked link is defused: its bracket is escaped.
    expect(alert).toContain('\\\\[click](');
    expect(alert).not.toMatch(/<@&|@everyone|@here/);
    // A second click: nothing sent again.
    await expect(run()).resolves.toBe('already');
    expect(deps.announce).toHaveBeenCalledTimes(1);
  });

  it('not one of the host’s own upcoming events: nothing claimed or sent', async () => {
    const { store, deps, run } = setup({ events: [{ ...EVENT, id: '999' }] });
    await expect(run()).resolves.toBe('not-yours');
    expect(store.claim).not.toHaveBeenCalled();
    expect(deps.announce).not.toHaveBeenCalled();
  });

  it('a click while another is sending sends nothing', async () => {
    const { deps, run } = setup({ start: 'sending' });
    await expect(run()).resolves.toBe('in-progress');
    expect(deps.announce).not.toHaveBeenCalled();
  });

  it('two clicks at once: one send', async () => {
    let release: (() => void) | undefined;
    const { store, deps, run } = setup({
      announce: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const one = run();
    await vi.waitFor(() => {
      expect(deps.announce).toHaveBeenCalledTimes(1);
    });
    const two = run();
    await vi.waitFor(() => {
      expect(store.claim).toHaveBeenCalledTimes(2);
    });
    release?.();
    expect([await one, await two]).toEqual(['sent', 'in-progress']);
    expect(deps.announce).toHaveBeenCalledTimes(1);
  });

  it('Meetup refuses it: failed, alerted, and it can be tried again', async () => {
    const { store, deps, run } = setup({
      announce: async () => {
        throw new MeetupPayloadError('announceEvent', [
          { code: 'NOT_ALLOWED', field: null, message: 'too soon' },
        ]);
      },
    });
    await expect(run()).resolves.toBe('failed');
    expect(store.rows.get(EVENT.id)).toMatchObject({
      status: 'failed',
      failure: 'NOT_ALLOWED: too soon',
    });
    expect(JSON.stringify(deps.alert.mock.calls)).toContain(
      'Meetup refused it',
    );
    deps.announce.mockResolvedValueOnce(undefined);
    await expect(run()).resolves.toBe('sent');
    expect(deps.announce).toHaveBeenCalledTimes(2);
  });

  it('Meetup says it was already announced: done, not a failure', async () => {
    const { store, deps, run } = setup({
      announce: async () => {
        throw graphqlError('This event has already been announced');
      },
    });
    await expect(run()).resolves.toBe('already');
    expect(store.rows.get(EVENT.id)?.status).toBe('sent');
    expect(deps.alert).not.toHaveBeenCalled();
  });

  it('no organizer token: nothing was called, so it is a plain failure', async () => {
    const { store, run } = setup({
      announce: async () => {
        throw new OrganizerTokenUnavailableError();
      },
    });
    await expect(run()).resolves.toBe('failed');
    expect(store.rows.get(EVENT.id)?.status).toBe('failed');
  });

  it('no answer (a dropped connection, an HTTP 502, no confirmation): unconfirmed, and it can be tried again', async () => {
    for (const thrown of [
      new Error('socket hang up'),
      graphqlError('bad gateway', 502),
      new Error('announceEvent did not confirm the event'),
    ]) {
      const { store, deps, run } = setup({
        announce: async () => {
          throw thrown;
        },
      });
      // eslint-disable-next-line no-await-in-loop
      await expect(run()).resolves.toBe('unconfirmed');
      expect(store.rows.get(EVENT.id)?.status).toBe('unknown');
      expect(JSON.stringify(deps.alert.mock.calls)).toContain(
        'may or may not have gone out',
      );
      deps.announce.mockResolvedValueOnce(undefined);
      // eslint-disable-next-line no-await-in-loop
      await expect(run()).resolves.toBe('sent');
      expect(deps.announce).toHaveBeenCalledTimes(2);
    }
  });

  it('a 4xx carrying Meetup’s "already announced" is done, like a 200 one', async () => {
    const { store, run } = setup({
      announce: async () => {
        throw graphqlError('Event has already been announced.', 400);
      },
    });
    await expect(run()).resolves.toBe('already');
    expect(store.rows.get(EVENT.id)?.status).toBe('sent');
  });

  it('a 4xx (a refused or expired token, a rate limit) is a refusal: failed, retryable', async () => {
    for (const status of [400, 401, 403, 429]) {
      const { store, run } = setup({
        announce: async () => {
          throw graphqlError('nope', status);
        },
      });
      // eslint-disable-next-line no-await-in-loop
      await expect(run()).resolves.toBe('failed');
      expect(store.rows.get(EVENT.id)?.status).toBe('failed');
    }
  });

  it('only Meetup’s exact "already announced" counts as done; anything near it is a refusal', async () => {
    const said = async (message: string, code = 'INVALID') => {
      const { run } = setup({
        announce: async () => {
          throw new MeetupPayloadError('announceEvent', [
            { code, field: null, message },
          ]);
        },
      });
      return run();
    };
    await expect(said('Event has already been announced.')).resolves.toBe(
      'already',
    );
    await expect(said('anything', 'ALREADY_ANNOUNCED')).resolves.toBe(
      'already',
    );
    await expect(
      said('This event has not already been announced'),
    ).resolves.toBe('failed');
    await expect(
      said('Cannot announce: event already announced by organizer today'),
    ).resolves.toBe('failed');
  });

  it('a store that cannot record the result leaves it "sending": never sent twice', async () => {
    const { store, deps, run } = setup();
    store.finish.mockRejectedValueOnce(new Error('pg down'));
    await expect(run()).resolves.toBe('sent');
    await expect(run()).resolves.toBe('in-progress');
    expect(deps.announce).toHaveBeenCalledTimes(1);
  });

  it('a claim that fails throws, and nothing is sent', async () => {
    const { store, deps, run } = setup();
    store.claim.mockRejectedValueOnce(new Error('pg down'));
    await expect(run()).rejects.toThrow('pg down');
    expect(deps.announce).not.toHaveBeenCalled();
  });
});

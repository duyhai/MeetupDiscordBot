import { ClientError } from 'graphql-request';
import { describe, expect, it, vi } from 'vitest';

import { MeetupPayloadError } from '../../../src/lib/client/meetup/payloadErrors.js';
import {
  AnnounceDeps,
  AnnounceEventDetails,
  announceHostEvent,
  cancelHeldAnnouncement,
} from '../../../src/lib/hosts/announceEvent.js';
import { HostEvent } from '../../../src/lib/hosts/hostEvents.js';
import { OrganizerTokenUnavailableError } from '../../../src/lib/reports/organizerMeetup.js';
import {
  Announcement,
  AnnouncementStatus,
} from '../../../src/lib/repositories/postgresEventAnnouncementRepository.js';

const HOST = { meetupMemberId: '12345', name: 'Dee *Host*' };
// Tue 10 Nov 2026, 19:30 PST: outside the work-hours hold.
const NOW = new Date('2026-11-11T03:30:00Z');
const WORK_HOURS = new Date('2026-11-10T19:15:00Z'); // 11:15 PST
const EVENT: HostEvent = {
  id: '311111111',
  title: 'Board games [click](https://evil.example)',
  dateTime: '2026-11-28T19:00:00-08:00',
  eventUrl: 'https://www.meetup.com/g/events/311111111/',
  type: 'games',
  counted: true,
  hosts: [{ id: HOST.meetupMemberId, name: HOST.name }],
};
const DETAILS: AnnounceEventDetails = {
  id: EVENT.id,
  title: EVENT.title,
  eventUrl: EVENT.eventUrl,
  dateTime: EVENT.dateTime,
  createdTime: '2026-11-01T12:00:00-08:00',
  rsvpState: 'RSVP',
  rsvpsClosed: false,
  hosts: EVENT.hosts,
};

/** The store in memory, with Postgres's one-statement claim and hold. */
function memoryStore(start?: AnnouncementStatus, dueAt: Date | null = null) {
  const rows = new Map<string, Announcement>();
  const row = (
    id: string,
    by: string,
    status: AnnouncementStatus,
    due: Date | null = null,
  ): Announcement => ({
    meetupEventId: id,
    requestedBy: by,
    status,
    failure: null,
    requestedAt: new Date(),
    completedAt: null,
    dueAt: due,
  });
  if (start) {
    rows.set(EVENT.id, row(EVENT.id, HOST.meetupMemberId, start, dueAt));
  }
  const reclaimable = (current: Announcement | undefined) =>
    current === undefined ||
    ['failed', 'unknown', 'cancelled'].includes(current.status);
  return {
    rows,
    claim: vi.fn(async (id: string, by: string) => {
      const current = rows.get(id);
      if (reclaimable(current)) {
        rows.set(id, row(id, by, 'sending'));
        return { claimed: true as const };
      }
      return { claimed: false as const, current: current };
    }),
    hold: vi.fn(async (id: string, by: string, due: Date) => {
      const current = rows.get(id);
      if (reclaimable(current)) {
        rows.set(id, row(id, by, 'held', due));
        return { held: true as const };
      }
      return { held: false as const, current: current };
    }),
    finish: vi.fn(
      async (
        id: string,
        status: Exclude<AnnouncementStatus, 'sending' | 'held' | 'cancelled'>,
        failure: string | null = null,
      ) => {
        const row = rows.get(id);
        if (row?.status === 'sending') {
          rows.set(id, { ...row, status, failure });
        }
      },
    ),
    otherTimes: vi.fn(async () => [] as Date[]),
  };
}

function setup(
  options: {
    start?: AnnouncementStatus;
    dueAt?: Date;
    announce?: () => Promise<void>;
    events?: HostEvent[];
    details?: Partial<AnnounceEventDetails> | undefined;
    now?: Date;
    others?: Date[];
  } = {},
) {
  const store = memoryStore(options.start, options.dueAt ?? null);
  store.otherTimes.mockResolvedValue(options.others ?? []);
  const deps = {
    announcements: async () => store,
    ownUpcoming: vi.fn(async () => options.events ?? [EVENT]),
    eventDetails: vi.fn(async () => {
      if ('details' in options && options.details === undefined) {
        return undefined;
      }
      return { ...DETAILS, ...options.details };
    }),
    announce: vi.fn(options.announce ?? (async () => undefined)),
    alert: vi.fn().mockResolvedValue(true),
    now: () => options.now ?? NOW,
  } satisfies AnnounceDeps;
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

  it('not one of the host’s own upcoming events: nothing read, claimed or sent', async () => {
    const { store, deps, run } = setup({ events: [{ ...EVENT, id: '999' }] });
    await expect(run()).resolves.toBe('not-yours');
    expect(deps.eventDetails).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(deps.announce).not.toHaveBeenCalled();
  });

  it('an event Meetup no longer has reads as not yours', async () => {
    const { run, store } = setup({ details: undefined });
    await expect(run()).resolves.toBe('not-yours');
    expect(store.claim).not.toHaveBeenCalled();
  });

  describe('pre-checks', () => {
    it('refuses while RSVPs are not open, before any claim', async () => {
      for (const details of [
        { rsvpState: 'NOT_OPEN_YET' },
        { rsvpState: 'CLOSED' },
        { rsvpsClosed: true },
      ]) {
        const { store, deps, run } = setup({ details });
        // eslint-disable-next-line no-await-in-loop
        await expect(run()).resolves.toBe('rsvps-closed');
        expect(store.claim).not.toHaveBeenCalled();
        expect(deps.announce).not.toHaveBeenCalled();
      }
    });

    it('Meetup saying nothing about RSVPs is unknown, not open', async () => {
      const { store, run } = setup({
        details: { rsvpState: null, rsvpsClosed: null },
      });
      await expect(run()).resolves.toBe('rsvps-unknown');
      expect(store.claim).not.toHaveBeenCalled();
    });

    it('refuses an event within 7 days that was created more than 7 days before it', async () => {
      const { store, run } = setup({
        now: new Date('2026-11-26T03:30:00Z'), // 2.7 days before the start
      });
      await expect(run()).resolves.toBe('too-late');
      expect(store.claim).not.toHaveBeenCalled();
    });

    it('a late-created event is announced even within 7 days', async () => {
      const { run } = setup({
        now: new Date('2026-11-26T03:30:00Z'),
        details: { createdTime: '2026-11-24T12:00:00-08:00' },
      });
      await expect(run()).resolves.toBe('sent');
    });

    it('without a created time, Meetup is the only judge', async () => {
      const { run } = setup({
        now: new Date('2026-11-26T03:30:00Z'),
        details: { createdTime: null },
      });
      await expect(run()).resolves.toBe('sent');
    });

    it('a Meetup read failing fails the request, sending nothing', async () => {
      const { deps, run } = setup();
      deps.eventDetails.mockRejectedValueOnce(new Error('meetup down'));
      await expect(run()).rejects.toThrow('meetup down');
      expect(deps.announce).not.toHaveBeenCalled();
    });
  });

  describe('the hold', () => {
    it('a work-hours request is held until 16:00 Pacific, nothing sent', async () => {
      const { store, deps, run } = setup({ now: WORK_HOURS });
      await expect(run()).resolves.toBe('scheduled');
      expect(deps.announce).not.toHaveBeenCalled();
      expect(store.hold).toHaveBeenCalledWith(
        EVENT.id,
        HOST.meetupMemberId,
        new Date('2026-11-11T00:00:00Z'),
      );
      expect(store.rows.get(EVENT.id)?.status).toBe('held');
      expect(deps.alert).not.toHaveBeenCalled();
      // A second click while held: scheduled, nothing more.
      await expect(run()).resolves.toBe('scheduled');
      expect(store.hold).toHaveBeenCalledTimes(2);
    });

    it('one within 30 minutes of another goes 30 minutes after it', async () => {
      const { store, run } = setup({
        others: [new Date(NOW.getTime() - 10 * 60 * 1000)],
      });
      await expect(run()).resolves.toBe('scheduled');
      expect(store.otherTimes).toHaveBeenCalledWith(
        EVENT.id,
        new Date(NOW.getTime() - 30 * 60 * 1000),
      );
      expect(store.hold.mock.calls[0]?.[2]).toEqual(
        new Date(NOW.getTime() + 20 * 60 * 1000),
      );
    });

    it('an event within 3 days goes at once, in work hours and next to another', async () => {
      const { deps, run } = setup({
        now: WORK_HOURS,
        details: {
          dateTime: '2026-11-11T19:00:00-08:00',
          createdTime: '2026-11-09T12:00:00-08:00',
        },
        others: [WORK_HOURS],
      });
      await expect(run()).resolves.toBe('sent');
      expect(deps.announce).toHaveBeenCalledTimes(1);
    });

    it('a held row that the host cancelled can be requested again', async () => {
      const { run } = setup({ start: 'cancelled' });
      await expect(run()).resolves.toBe('sent');
    });
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

  it('a 5xx, even with GraphQL errors, is no answer: unconfirmed', async () => {
    const { store, run } = setup({
      announce: async () => {
        throw graphqlError('Event has already been announced.', 503);
      },
    });
    await expect(run()).resolves.toBe('unconfirmed');
    expect(store.rows.get(EVENT.id)?.status).toBe('unknown');
  });

  it('a 4xx with GraphQL errors that are not "already announced" is a refusal', async () => {
    const { store, run } = setup({
      announce: async () => {
        throw graphqlError('Not authorized to announce this event', 403);
      },
    });
    await expect(run()).resolves.toBe('failed');
    expect(store.rows.get(EVENT.id)).toMatchObject({
      status: 'failed',
      failure: 'Not authorized to announce this event',
    });
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

describe('cancelHeldAnnouncement', () => {
  it('cancels the host’s own held one; not theirs, or not held, says so', async () => {
    const { deps } = setup();
    const cancel = vi.fn(async (id: string) => id === EVENT.id);
    await expect(
      cancelHeldAnnouncement(deps, cancel, HOST, EVENT.id),
    ).resolves.toBe('cancelled');
    await expect(
      cancelHeldAnnouncement(deps, cancel, HOST, '999'),
    ).resolves.toBe('not-yours');
    expect(cancel).toHaveBeenCalledTimes(1);
    cancel.mockResolvedValueOnce(false);
    await expect(
      cancelHeldAnnouncement(deps, cancel, HOST, EVENT.id),
    ).resolves.toBe('not-held');
  });
});

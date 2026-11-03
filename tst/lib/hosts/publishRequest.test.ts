import { ClientError } from 'graphql-request';
import { describe, expect, it, vi } from 'vitest';

import {
  PUBLISH_FAILURES,
  PublishDeps,
  publishRequest,
} from '../../../src/lib/hosts/publishRequest.js';
import {
  EventRequest,
  PublishFrom,
} from '../../../src/lib/repositories/postgresEventRequestRepository.js';

const LEAD = '223456789012345678';
const NOW = new Date('2026-11-03T20:00:00Z');
const URL = 'https://www.meetup.com/1-5genasians/events/317000001/';

const base = (over: Partial<EventRequest> = {}): EventRequest => ({
  id: '7',
  meetupMemberId: '4242',
  discordUserId: null,
  hostName: 'Hana',
  tier: 'regular',
  kind: 'fresh',
  sourceEventId: null,
  title: 'Hot pot',
  description: 'desc',
  startLocal: '2026-12-05T18:30',
  duration: 'PT2H',
  rsvpLimit: 10,
  guestLimit: 1,
  featuredPhotoId: 503707686,
  venueId: null,
  howToFindUs: null,
  status: 'pending',
  denyReason: null,
  failure: null,
  decidedBy: null,
  decidedAt: null,
  meetupEventId: null,
  eventUrl: null,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

/** An in-memory store with the repository's compare-and-set semantics. */
function store(initial: EventRequest) {
  let row = { ...initial };
  const requests: PublishDeps['requests'] = {
    startPublishing: vi.fn(
      async (
        _id: string,
        seen: number,
        actor: string,
        from: PublishFrom[],
        stuckBefore?: Date,
      ) => {
        await Promise.resolve();
        const allowed =
          from.includes(row.status as PublishFrom) &&
          (row.status !== 'publishing' ||
            (stuckBefore !== undefined && row.updatedAt < stuckBefore));
        if (row.version !== seen || !allowed) {
          return undefined;
        }
        row = {
          ...row,
          status: 'publishing',
          version: row.version + 1,
          decidedBy: row.decidedBy ?? actor,
          failure: null,
        };
        return { ...row };
      },
    ),
    recordCreated: vi.fn(
      async (_id: string, version: number, eventId: string, url: string) => {
        await Promise.resolve();
        if (
          row.status !== 'publishing' ||
          row.version !== version ||
          row.meetupEventId !== null
        ) {
          return false;
        }
        row = {
          ...row,
          meetupEventId: eventId,
          eventUrl: url,
          version: row.version + 1,
        };
        return true;
      },
    ),
    finish: vi.fn(
      async (
        _id: string,
        version: number,
        outcome:
          { status: 'published' } | { status: 'failed'; failure: string },
      ) => {
        await Promise.resolve();
        if (row.status !== 'publishing' || row.version !== version) {
          return undefined;
        }
        row = {
          ...row,
          status: outcome.status,
          failure: outcome.status === 'failed' ? outcome.failure : null,
          version: row.version + 1,
        };
        return { ...row };
      },
    ),
  };
  return { requests, row: () => row };
}

function meetupFake() {
  return {
    createEvent: vi.fn().mockResolvedValue({
      createEvent: { event: { id: '317000001', eventUrl: URL } },
    }),
    closeEventRsvps: vi.fn().mockResolvedValue({}),
    editEvent: vi.fn().mockResolvedValue({}),
  };
}

function deps(initial: EventRequest, over: Partial<PublishDeps> = {}) {
  const s = store(initial);
  const meetup = meetupFake();
  const d: PublishDeps = {
    requests: s.requests,
    organizer: async () => Promise.resolve(meetup),
    findExisting: vi.fn().mockResolvedValue(undefined),
    tierOf: vi.fn().mockResolvedValue('regular'),
    alert: vi.fn().mockResolvedValue(true),
    now: () => NOW,
    ...over,
  };
  return { d, meetup, row: s.row };
}

describe('publishRequest', () => {
  it('publishes: creates, records, closes RSVPs and re-applies the limits', async () => {
    const { d, meetup, row } = deps(base());
    const outcome = await publishRequest(d, '7', 1, LEAD, ['pending']);
    expect(outcome.code).toBe('published');
    expect(meetup.createEvent).toHaveBeenCalledTimes(1);
    expect(meetup.createEvent.mock.calls[0][0]).toMatchObject({
      title: '[Guest Host] Hot pot',
      eventHosts: [4242],
      startDateTime: '2026-12-05T18:30',
    });
    expect(meetup.closeEventRsvps).toHaveBeenCalledWith({
      eventId: '317000001',
    });
    expect(meetup.editEvent).toHaveBeenCalledWith({
      eventId: '317000001',
      rsvpSettings: expect.objectContaining({
        rsvpLimit: 10,
        guestLimit: 1,
      }) as unknown,
    });
    expect(row()).toMatchObject({
      status: 'published',
      meetupEventId: '317000001',
      eventUrl: URL,
    });
    expect(d.alert).not.toHaveBeenCalled();
  });

  it('two approvals at once create one event', async () => {
    const { d, meetup } = deps(base());
    const outcomes = await Promise.all([
      publishRequest(d, '7', 1, LEAD, ['pending']),
      publishRequest(d, '7', 1, '323456789012345678', ['pending']),
    ]);
    expect(outcomes.map((o) => o.code).sort()).toEqual(['published', 'stale']);
    expect(meetup.createEvent).toHaveBeenCalledTimes(1);
  });

  it('a stale version publishes nothing', async () => {
    const { d, meetup } = deps(base({ version: 3 }));
    expect((await publishRequest(d, '7', 1, LEAD, ['pending'])).code).toBe(
      'stale',
    );
    expect(meetup.createEvent).not.toHaveBeenCalled();
  });

  it('prefixes by the tier at publish, not at submit', async () => {
    const { d, meetup } = deps(base({ tier: 'promoted' }));
    await publishRequest(d, '7', 1, LEAD, ['pending']);
    expect(meetup.createEvent.mock.calls[0][0]).toMatchObject({
      title: '[Guest Host] Hot pot',
    });
    const promoted = deps(base(), {
      tierOf: vi.fn().mockResolvedValue('promoted'),
    });
    await publishRequest(promoted.d, '7', 1, LEAD, ['pending']);
    expect(promoted.meetup.createEvent.mock.calls[0][0]).toMatchObject({
      title: '[Community Host] Hot pot',
    });
  });

  it('a retry with a created event only redoes the RSVP steps', async () => {
    const { d, meetup, row } = deps(
      base({
        status: 'failed',
        version: 5,
        meetupEventId: '317000001',
        eventUrl: URL,
      }),
    );
    const outcome = await publishRequest(d, '7', 5, LEAD, [
      'failed',
      'publishing',
    ]);
    expect(outcome.code).toBe('published');
    expect(meetup.createEvent).not.toHaveBeenCalled();
    expect(d.tierOf).not.toHaveBeenCalled();
    expect(meetup.closeEventRsvps).toHaveBeenCalledWith({
      eventId: '317000001',
    });
    expect(row().status).toBe('published');
  });

  it('a stuck publish is retried only once it is old enough', async () => {
    const fresh = deps(
      base({
        status: 'publishing',
        updatedAt: new Date(NOW.getTime() - 60_000),
      }),
    );
    expect(
      (await publishRequest(fresh.d, '7', 1, LEAD, ['failed', 'publishing']))
        .code,
    ).toBe('stale');
    const stuck = deps(
      base({
        status: 'publishing',
        updatedAt: new Date(NOW.getTime() - 11 * 60_000),
      }),
    );
    expect(
      (await publishRequest(stuck.d, '7', 1, LEAD, ['failed', 'publishing']))
        .code,
    ).toBe('published');
  });

  it('createEvent failing records that nothing is known to exist, and alerts', async () => {
    const { d, meetup, row } = deps(base());
    meetup.createEvent.mockRejectedValue(new Error('boom'));
    const outcome = await publishRequest(d, '7', 1, LEAD, ['pending']);
    expect(outcome.code).toBe('failed');
    expect(row()).toMatchObject({
      status: 'failed',
      failure: PUBLISH_FAILURES.createFailed,
      meetupEventId: null,
    });
    expect(d.alert).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(d.alert).mock.calls[0][0];
    expect(JSON.stringify(entry)).not.toMatch(/<@|@everyone|@here/);
    expect(entry.description).toBe(PUBLISH_FAILURES.createFailed);
  });

  it('the photo fallback still applies', async () => {
    const { d, meetup } = deps(base());
    meetup.createEvent
      .mockRejectedValueOnce(
        new ClientError(
          { status: 200, errors: [{ message: 'photo not found' }] } as never,
          { query: '' },
        ),
      )
      .mockResolvedValueOnce({
        createEvent: { event: { id: '317000001', eventUrl: URL } },
      });
    expect((await publishRequest(d, '7', 1, LEAD, ['pending'])).code).toBe(
      'published',
    );
    expect(meetup.createEvent.mock.calls[1][0]).not.toHaveProperty(
      'featuredPhotoId',
    );
  });

  it('an RSVP failure names the created event and keeps it for the retry', async () => {
    const { d, meetup, row } = deps(base());
    meetup.closeEventRsvps.mockRejectedValue(new Error('boom'));
    const outcome = await publishRequest(d, '7', 1, LEAD, ['pending']);
    expect(outcome.code).toBe('failed');
    expect(row()).toMatchObject({
      status: 'failed',
      meetupEventId: '317000001',
      failure: PUBLISH_FAILURES.rsvp(URL),
    });
  });

  it('a member who is no longer a host is not published', async () => {
    const { d, meetup, row } = deps(base(), {
      tierOf: vi.fn().mockResolvedValue('not-a-host'),
    });
    expect((await publishRequest(d, '7', 1, LEAD, ['pending'])).code).toBe(
      'failed',
    );
    expect(meetup.createEvent).not.toHaveBeenCalled();
    expect(row().failure).toBe(PUBLISH_FAILURES.notAHost);
  });

  it('an unusable organizer login or tier check fails without a Meetup write', async () => {
    const noLogin = deps(base(), {
      organizer: vi.fn().mockRejectedValue(new Error('no token')),
    });
    await publishRequest(noLogin.d, '7', 1, LEAD, ['pending']);
    expect(noLogin.row().failure).toBe(PUBLISH_FAILURES.noOrganizer);
    const noTier = deps(base(), {
      tierOf: vi.fn().mockRejectedValue(new Error('discord down')),
    });
    await publishRequest(noTier.d, '7', 1, LEAD, ['pending']);
    expect(noTier.row().failure).toBe(PUBLISH_FAILURES.tierUnknown);
    expect(noTier.meetup.createEvent).not.toHaveBeenCalled();
  });

  it('a created event that cannot be recorded says not to retry', async () => {
    const { d } = deps(base());
    vi.mocked(d.requests.recordCreated).mockRejectedValue(new Error('pg down'));
    const outcome = await publishRequest(d, '7', 1, LEAD, ['pending']);
    expect(outcome).toMatchObject({
      code: 'failed',
      request: { failure: PUBLISH_FAILURES.notRecorded(URL) },
    });
  });

  it('a retry with nothing recorded adopts the event an earlier attempt made', async () => {
    const { d, meetup, row } = deps(
      base({
        status: 'failed',
        version: 4,
        failure: PUBLISH_FAILURES.notRecorded(URL),
      }),
      {
        findExisting: vi
          .fn()
          .mockResolvedValue({ id: '317000001', eventUrl: URL }),
      },
    );
    const outcome = await publishRequest(d, '7', 4, LEAD, [
      'failed',
      'publishing',
    ]);
    expect(outcome.code).toBe('published');
    expect(meetup.createEvent).not.toHaveBeenCalled();
    expect(meetup.closeEventRsvps).toHaveBeenCalledWith({
      eventId: '317000001',
    });
    expect(row()).toMatchObject({
      status: 'published',
      meetupEventId: '317000001',
    });
  });

  it('a retry that finds nothing on Meetup creates the event', async () => {
    const { d, meetup } = deps(base({ status: 'failed', version: 4 }));
    expect(
      (await publishRequest(d, '7', 4, LEAD, ['failed', 'publishing'])).code,
    ).toBe('published');
    expect(d.findExisting).toHaveBeenCalledTimes(1);
    expect(meetup.createEvent).toHaveBeenCalledTimes(1);
  });

  it('a first approval does not look on Meetup', async () => {
    const { d } = deps(base());
    await publishRequest(d, '7', 1, LEAD, ['pending']);
    expect(d.findExisting).not.toHaveBeenCalled();
  });

  it('a retry that cannot ask Meetup creates nothing', async () => {
    const { d, meetup, row } = deps(base({ status: 'failed', version: 4 }), {
      findExisting: vi.fn().mockRejectedValue(new Error('down')),
    });
    expect(
      (await publishRequest(d, '7', 4, LEAD, ['failed', 'publishing'])).code,
    ).toBe('failed');
    expect(meetup.createEvent).not.toHaveBeenCalled();
    expect(row().failure).toBe(PUBLISH_FAILURES.checkFailed);
  });

  it('a resumed retry without an organizer login says the event exists', async () => {
    const { d, row } = deps(
      base({
        status: 'failed',
        version: 5,
        meetupEventId: '317000001',
        eventUrl: URL,
      }),
      { organizer: vi.fn().mockRejectedValue(new Error('no token')) },
    );
    await publishRequest(d, '7', 5, LEAD, ['failed', 'publishing']);
    expect(row()).toMatchObject({
      status: 'failed',
      meetupEventId: '317000001',
      failure: PUBLISH_FAILURES.noOrganizerCreated(URL),
    });
  });

  it('an overtaken publisher records nothing and flags a possible duplicate', async () => {
    const { d, meetup, row } = deps(base());
    // Another publisher takes the row over while createEvent runs.
    meetup.createEvent.mockImplementation(async () => {
      await d.requests.startPublishing(
        '7',
        2,
        '323456789012345678',
        ['publishing'],
        new Date(NOW.getTime() + 60 * 60_000),
      );
      return { createEvent: { event: { id: '317000001', eventUrl: URL } } };
    });
    const outcome = await publishRequest(d, '7', 1, LEAD, ['pending']);
    expect(outcome.code).toBe('stale');
    expect(row()).toMatchObject({
      status: 'publishing',
      meetupEventId: null,
      version: 3,
    });
    expect(meetup.closeEventRsvps).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(d.alert).mock.calls[0][0])).toContain(
      'check for a duplicate',
    );
  });

  it('a lost "published" write still reports published and alerts', async () => {
    const { d } = deps(base());
    vi.mocked(d.requests.finish).mockRejectedValue(new Error('pg down'));
    const outcome = await publishRequest(d, '7', 1, LEAD, ['pending']);
    expect(outcome).toMatchObject({
      code: 'published',
      request: { meetupEventId: '317000001' },
    });
    expect(d.alert).toHaveBeenCalledTimes(1);
  });
});

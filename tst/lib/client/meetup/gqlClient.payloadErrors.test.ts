import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Configuration from '../../../../src/configuration.js';
import { GqlMeetupClient } from '../../../../src/lib/client/meetup/gqlClient.js';
import { MeetupPayloadError } from '../../../../src/lib/client/meetup/payloadErrors.js';
import { ApplicationCache } from '../../../../src/util/cache.js';
import { FakeCache } from '../../../web/fakeCache.js';

vi.mock('../../../../src/util/cache.js', () => ({ ApplicationCache: vi.fn() }));

const ENDPOINT = new URL(Configuration.meetup.endpoint);
const URL_1 = 'https://www.meetup.com/1-5genasians/events/317000001/';
const REJECTED = [
  { code: 'INVALID_ARGUMENT', field: 'rsvpSettings', message: 'bad limit' },
];

beforeEach(() => {
  vi.mocked(ApplicationCache).mockResolvedValue(new FakeCache() as never);
});

afterEach(() => {
  nock.cleanAll();
  vi.restoreAllMocks();
});

/** Answers the next POST with `data`, and keeps the query it was sent. */
function answer(data: unknown): { query: () => string } {
  let sent = '';
  nock(ENDPOINT.origin)
    .post(ENDPOINT.pathname, (body: { query: string }) => {
      sent = body.query;
      return true;
    })
    .reply(200, { data });
  return { query: () => sent };
}

const client = () => new GqlMeetupClient('t');

describe('Meetup mutation payload errors', () => {
  it('each write asks Meetup for its payload errors', async () => {
    const create = answer({
      createEvent: { event: { id: '1', eventUrl: URL_1 }, errors: [] },
    });
    await client().createEvent({} as never);
    const edit = answer({ editEvent: { event: null, errors: [] } });
    await client().editEvent({ eventId: '1' });
    const close = answer({ closeEventRsvps: { event: null, errors: [] } });
    await client().closeEventRsvps({ eventId: '1' });
    for (const sent of [create, edit, close]) {
      expect(sent.query()).toMatch(/errors\s*\{\s*code\s+field\s+message\s*\}/);
    }
  });

  it('editEvent and closeEventRsvps throw when Meetup rejects them', async () => {
    answer({ editEvent: { event: null, errors: REJECTED } });
    await expect(client().editEvent({ eventId: '1' })).rejects.toBeInstanceOf(
      MeetupPayloadError,
    );
    answer({ closeEventRsvps: { event: null, errors: REJECTED } });
    await expect(client().closeEventRsvps({ eventId: '1' })).rejects.toThrow(
      /closeEventRsvps was rejected by Meetup: INVALID_ARGUMENT/,
    );
  });

  it('announceEvent asks for its payload errors and throws when Meetup rejects it', async () => {
    const ok = answer({ announceEvent: { event: { id: '1' }, errors: [] } });
    await client().announceEvent({ eventId: '1' });
    expect(ok.query()).toMatch(/errors\s*\{\s*code\s+field\s+message\s*\}/);
    answer({ announceEvent: { event: null, errors: REJECTED } });
    await expect(
      client().announceEvent({ eventId: '1' }),
    ).rejects.toBeInstanceOf(MeetupPayloadError);
  });

  it('announceEvent without errors but without the event is not a confirmation', async () => {
    answer({ announceEvent: { event: null, errors: [] } });
    await expect(client().announceEvent({ eventId: '1' })).rejects.toThrow(
      'did not confirm',
    );
    answer({ announceEvent: null });
    await expect(client().announceEvent({ eventId: '1' })).rejects.toThrow(
      'did not confirm',
    );
    answer({ announceEvent: { event: { id: '2' }, errors: [] } });
    await expect(client().announceEvent({ eventId: '1' })).rejects.toThrow(
      'did not confirm',
    );
  });

  it('createEvent throws on errors with no event', async () => {
    answer({ createEvent: { event: null, errors: REJECTED } });
    await expect(client().createEvent({} as never)).rejects.toBeInstanceOf(
      MeetupPayloadError,
    );
  });

  it('createEvent returns an event that exists even with errors beside it', async () => {
    answer({
      createEvent: { event: { id: '1', eventUrl: URL_1 }, errors: REJECTED },
    });
    const result = await client().createEvent({} as never);
    expect(result.createEvent.event?.id).toBe('1');
  });
});

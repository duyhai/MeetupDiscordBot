import { describe, expect, it, vi } from 'vitest';

import { PublishOutcome } from '../../../src/lib/hosts/publishRequest.js';
import {
  DecisionDeps,
  DecisionInput,
  decideRequest,
} from '../../../src/lib/hosts/requestDecision.js';
import { EventRequest } from '../../../src/lib/repositories/postgresEventRequestRepository.js';
import {
  PAGE_NOW,
  eventRequestRow,
  fakeEventRequests,
} from '../../web/routes/pageFakes.js';

const LEADER = '223456789012345678';

function setup(
  options: {
    rows?: EventRequest[];
    leader?: boolean | Error;
    publish?: PublishOutcome;
    mirror?: (request: EventRequest) => Promise<unknown>;
    existing?: { id: string; eventUrl: string } | Error;
  } = {},
) {
  const store = fakeEventRequests(options.rows ?? [eventRequestRow()]);
  const publishRequest = vi.fn(
    async (): Promise<PublishOutcome> =>
      options.publish ?? {
        code: 'published',
        request: eventRequestRow({
          status: 'published',
          eventUrl: 'https://www.meetup.com/x/events/9/',
        }),
      },
  );
  const audit = vi.fn().mockResolvedValue(true);
  const mirror = vi.fn(options.mirror ?? (async () => undefined));
  // One refusal audit per actor, as the route's one-a-minute limiter.
  const refused = new Set<string>();
  let seen = 0;
  const deps: DecisionDeps = {
    now: () => PAGE_NOW,
    isLeadership: vi.fn(async () => {
      if (options.leader instanceof Error) {
        throw options.leader;
      }
      return options.leader ?? true;
    }),
    audit,
    store: async () => store,
    publishRequest,
    findExistingEvent: vi.fn(async () => {
      if (options.existing instanceof Error) {
        throw options.existing;
      }
      return options.existing;
    }),
    mirror,
    refusals: { take: (actor: string) => refused.add(actor).size > seen++ },
    denyCheckDeadlineMs: 50,
  };
  const decide = (input: Partial<DecisionInput> = {}) =>
    decideRequest(deps, {
      id: '1',
      version: 1,
      actor: LEADER,
      action: 'approve',
      ...input,
    });
  return { store, publishRequest, audit, mirror, decide };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('decideRequest', () => {
  it('refuses a non-leader and audits the refusal once a minute', async () => {
    const { decide, publishRequest, audit } = setup({ leader: false });
    expect((await decide()).code).toBe('not-leadership');
    expect((await decide()).code).toBe('not-leadership');
    expect(publishRequest).not.toHaveBeenCalled();
    const refusals = audit.mock.calls.filter(([e]) =>
      JSON.stringify(e).includes('refused'),
    );
    expect(refusals).toHaveLength(1);
  });

  it('answers leadership-unavailable when Discord cannot be asked', async () => {
    const { decide } = setup({ leader: new Error('down') });
    expect((await decide()).code).toBe('leadership-unavailable');
  });

  it('approves through publishRequest, audits and mirrors the published request', async () => {
    const { decide, publishRequest, audit, mirror } = setup();
    const outcome = await decide();
    expect(outcome.code).toBe('published');
    expect(publishRequest).toHaveBeenCalledWith(
      '1',
      1,
      LEADER,
      ['pending'],
      {},
    );
    expect(JSON.stringify(audit.mock.calls.at(-1)?.[0])).toContain(
      'Host request approved',
    );
    await settle();
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(mirror.mock.calls[0][0].status).toBe('published');
  });

  it('an approval records the reviewer checklist; a retry or a Discord approval records none', async () => {
    const { decide, publishRequest } = setup();
    await decide({ checklist: ['location', 'rsvps'] });
    expect(publishRequest).toHaveBeenLastCalledWith(
      '1',
      1,
      LEADER,
      ['pending'],
      {
        detail: '{"checklist":["location","rsvps"]}',
      },
    );
    await decide({ checklist: [] });
    expect(publishRequest).toHaveBeenLastCalledWith(
      '1',
      1,
      LEADER,
      ['pending'],
      {
        detail: '{"checklist":[]}',
      },
    );
    await decide({ action: 'retry', checklist: ['photo'] });
    expect(publishRequest).toHaveBeenLastCalledWith(
      '1',
      1,
      LEADER,
      ['failed', 'publishing'],
      {},
    );
  });

  it('a stale approval mirrors nothing', async () => {
    const { decide, mirror } = setup({ publish: { code: 'stale' } });
    expect((await decide({ version: 3 })).code).toBe('stale');
    await settle();
    expect(mirror).not.toHaveBeenCalled();
  });

  it('a retry publishes from failed or stuck publishing', async () => {
    const { decide, publishRequest } = setup({
      rows: [eventRequestRow({ status: 'failed', failure: 'x', version: 2 })],
    });
    await decide({ action: 'retry', version: 2 });
    expect(publishRequest).toHaveBeenCalledWith(
      '1',
      2,
      LEADER,
      ['failed', 'publishing'],
      {},
    );
  });

  it('deny needs a reason within the limit', async () => {
    const { decide, store } = setup();
    expect((await decide({ action: 'deny', reason: '  ' })).code).toBe(
      'reason-required',
    );
    expect(
      (await decide({ action: 'deny', reason: 'x'.repeat(501) })).code,
    ).toBe('reason-too-long');
    expect(store.deny).not.toHaveBeenCalled();
  });

  it('denies a waiting request, audits and mirrors it', async () => {
    const { decide, store, audit, mirror } = setup();
    const outcome = await decide({ action: 'deny', reason: 'Too soon\r\n' });
    expect(outcome.code).toBe('denied');
    expect(store.deny).toHaveBeenCalledWith(
      '1',
      1,
      LEADER,
      'Too soon',
      expect.objectContaining({
        lockTimeoutMs: expect.any(Number) as unknown,
      }) as unknown,
    );
    expect(JSON.stringify(audit.mock.calls.at(-1)?.[0])).toContain(
      'Host request denied',
    );
    await settle();
    expect(mirror.mock.calls[0][0].status).toBe('denied');
  });

  it('a deny on a changed version is stale', async () => {
    const { decide } = setup();
    expect(
      (await decide({ action: 'deny', reason: 'No', version: 2 })).code,
    ).toBe('stale');
  });

  it('will not deny a failed request whose event is on Meetup', async () => {
    const { decide, store } = setup({
      rows: [eventRequestRow({ status: 'failed', failure: 'x' })],
      existing: { id: '9', eventUrl: 'https://www.meetup.com/x/events/9/' },
    });
    expect((await decide({ action: 'deny', reason: 'No' })).code).toBe(
      'deny-event-exists',
    );
    expect(store.deny).not.toHaveBeenCalled();
  });

  it('will not deny a failed request when Meetup cannot be asked', async () => {
    const { decide } = setup({
      rows: [eventRequestRow({ status: 'failed', failure: 'x' })],
      existing: new Error('meetup down'),
    });
    expect((await decide({ action: 'deny', reason: 'No' })).code).toBe(
      'deny-check-failed',
    );
  });

  it('resolves a failed request with a recorded event', async () => {
    const { decide, mirror } = setup({
      rows: [
        eventRequestRow({
          status: 'failed',
          failure: 'x',
          meetupEventId: '9',
          eventUrl: 'https://www.meetup.com/x/events/9/',
        }),
      ],
    });
    expect((await decide({ action: 'resolve' })).code).toBe('resolved');
    await settle();
    expect(mirror.mock.calls[0][0].status).toBe('published');
  });

  it('mirror failure does not change the outcome', async () => {
    const { decide } = setup({
      mirror: async () => {
        throw new Error('discord down');
      },
    });
    expect((await decide()).code).toBe('published');
    await settle();
  });
});

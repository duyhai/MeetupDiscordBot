import { describe, expect, it, vi } from 'vitest';

import { AnnounceCode } from '../../../src/lib/hosts/announceEvent.js';
import { CopySource } from '../../../src/lib/hosts/eventRequest.js';
import { HostEvent } from '../../../src/lib/hosts/hostEvents.js';
import {
  RecreateDeps,
  recreatable,
  recreateAndAnnounce,
  recreateInput,
} from '../../../src/lib/hosts/recreateEvent.js';
import { createEventTemplate } from '../../../src/templates/createEventTemplate.js';

const HOST = { meetupMemberId: '4242', name: 'Ann *N*' };
const CO_HOST = '5151';
const OLD: HostEvent = {
  id: '311111111',
  title: '[Guest Host] Hot pot [x](https://evil.example)',
  dateTime: '2026-11-14T19:00:00-08:00',
  eventUrl: 'https://www.meetup.com/g/events/311111111/',
  type: 'food',
  hosts: [
    { id: HOST.meetupMemberId, name: HOST.name },
    { id: CO_HOST, name: 'Bo' },
  ],
};
const SOURCE: CopySource = {
  id: OLD.id,
  eventUrl: OLD.eventUrl,
  title: OLD.title,
  description: 'Bring an appetite.',
  group: { urlname: createEventTemplate.groupUrlname },
  dateTime: OLD.dateTime,
  duration: 'PT2H30M',
  maxTickets: 12,
  guestLimit: 2,
  howToFindUs: 'Orange flag',
  featuredEventPhoto: { id: '520000001' },
  venue: { id: '27000001' },
  eventHosts: [
    { member: { id: HOST.meetupMemberId } },
    { member: { id: CO_HOST } },
  ],
};
const NEW_URL = 'https://www.meetup.com/g/events/322222222/';

/** The recreations table in memory, with Postgres's one-row claim. */
function memoryRecreations(existing?: string) {
  const rows = new Map<string, { newEventId: string | null; by: string }>();
  if (existing) {
    rows.set(OLD.id, { newEventId: existing, by: 'someone' });
  }
  return {
    rows,
    claim: vi.fn(async (oldId: string, by: string) => {
      if (rows.has(oldId)) {
        return false;
      }
      rows.set(oldId, { newEventId: null, by });
      return true;
    }),
    fill: vi.fn(async (oldId: string, newId: string) => {
      const row = rows.get(oldId);
      if (row && row.newEventId === null) {
        row.newEventId = newId;
      }
    }),
    release: vi.fn(async (oldId: string) => {
      if (rows.get(oldId)?.newEventId === null) {
        rows.delete(oldId);
      }
    }),
    get: vi.fn(async (oldId: string) => rows.get(oldId)),
  };
}

function setup(
  options: {
    others?: boolean;
    existing?: string;
    source?: CopySource | undefined;
    create?: () => Promise<unknown>;
    announce?: AnnounceCode;
    cancelFails?: boolean;
    /** The flag off: no cancel on Meetup. */
    noCancel?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const recreations = memoryRecreations(options.existing);
  const createEvent = vi.fn(async () => {
    calls.push('create');
    if (options.create) {
      return options.create();
    }
    return { createEvent: { event: { id: '322222222', eventUrl: NEW_URL } } };
  });
  const deps: RecreateDeps = {
    ownUpcoming: vi.fn(async () => [OLD]),
    othersRsvped: vi.fn(async () => options.others ?? false),
    copySource: vi.fn(async () => {
      return 'source' in options ? options.source : SOURCE;
    }),
    organizer: async () => ({ createEvent: createEvent as never }),
    cancelEvent: options.noCancel
      ? undefined
      : vi.fn(async () => {
          calls.push('cancel');
          if (options.cancelFails) {
            throw new Error('meetup down');
          }
        }),
    recreations: async () => recreations,
    announce: vi.fn(async () => {
      calls.push('announce');
      return options.announce ?? 'sent';
    }),
    alert: vi.fn().mockResolvedValue(true),
    audit: vi.fn().mockResolvedValue(true),
  };
  return {
    deps,
    calls,
    recreations,
    createEvent,
    alerts: () => JSON.stringify(vi.mocked(deps.alert).mock.calls),
    run: () => recreateAndAnnounce(deps, HOST, OLD.id),
  };
}

describe('recreateInput', () => {
  it('copies the event as it is: title verbatim, description, time, hosts, limits, photo, venue, directions', () => {
    const input = recreateInput(SOURCE, [HOST.meetupMemberId, CO_HOST]);
    expect(input).toMatchObject({
      title: OLD.title,
      description: 'Bring an appetite.',
      startDateTime: '2026-11-14T19:00',
      duration: 'PT2H30M',
      eventHosts: [4242, 5151],
      rsvpSettings: {
        ...createEventTemplate.rsvpSettings,
        rsvpLimit: 12,
        guestLimit: 2,
      },
      featuredPhotoId: 520000001,
      venueId: '27000001',
      howToFindUs: 'Orange flag',
      publishStatus: 'PUBLISHED',
      groupUrlname: createEventTemplate.groupUrlname,
    });
  });

  it('goes through the copy path’s checks: out-of-range limits, a bad venue id and a long direction fall back', () => {
    const input = recreateInput(
      {
        ...SOURCE,
        featuredEventPhoto: null,
        venue: { id: 'not a venue id!' },
        howToFindUs: 'x'.repeat(2500),
        maxTickets: 900,
        guestLimit: 50,
        duration: 'PT9H',
      },
      [HOST.meetupMemberId],
    );
    expect(input.featuredPhotoId).toBe(createEventTemplate.featuredPhotoId);
    expect(input).not.toHaveProperty('venueId');
    expect(input.howToFindUs).toHaveLength(2000);
    expect(input.rsvpSettings).toEqual(createEventTemplate.rsvpSettings);
    expect(input.duration).toBe('PT2H');
  });
});

describe('recreatable', () => {
  it('only the host’s own event, not yet recreated, with no RSVPs beyond the hosts', async () => {
    const { deps } = setup();
    await expect(recreatable(deps, HOST, OLD.id)).resolves.toEqual({
      ok: true,
    });
    await expect(recreatable(deps, HOST, '999')).resolves.toEqual({
      ok: false,
      reason: 'not-yours',
    });
    await expect(
      recreatable(setup({ others: true }).deps, HOST, OLD.id),
    ).resolves.toEqual({ ok: false, reason: 'has-rsvps' });
    await expect(
      recreatable(setup({ existing: '300000000' }).deps, HOST, OLD.id),
    ).resolves.toEqual({ ok: false, reason: 'already-recreated' });
  });
});

describe('recreateAndAnnounce', () => {
  it('claims, creates the copy, fills the link, announces it, then cancels the old one; alerts and audits', async () => {
    const { deps, calls, recreations, createEvent, alerts, run } = setup();
    const outcome = await run();
    expect(outcome).toMatchObject({
      code: 'recreated',
      announce: 'sent',
      photoDropped: false,
      newEvent: { id: '322222222', eventUrl: NEW_URL, title: OLD.title },
    });
    expect(calls).toEqual(['create', 'announce', 'cancel']);
    expect(recreations.claim).toHaveBeenCalledWith(OLD.id, HOST.meetupMemberId);
    expect(recreations.rows.get(OLD.id)).toEqual({
      newEventId: '322222222',
      by: HOST.meetupMemberId,
    });
    expect((createEvent.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
      title: OLD.title,
      eventHosts: [4242, 5151],
      venueId: '27000001',
    });
    expect(deps.announce).toHaveBeenCalledWith(
      HOST,
      expect.objectContaining({ id: '322222222' }),
    );
    expect(deps.cancelEvent).toHaveBeenCalledWith(OLD.id);
    expect(alerts()).toContain('recreated an event');
    expect(alerts()).toContain('Ann \\\\*N\\\\*');
    // The leading bracket is escaped, as alertText does for a masked link.
    expect(alerts()).toContain('\\\\[Guest Host]');
    expect(alerts()).not.toMatch(/<@&|@everyone|@here/);
    expect(JSON.stringify(vi.mocked(deps.audit).mock.calls)).toContain(
      'recreated an event',
    );
  });

  it('two clicks at once make one copy', async () => {
    const { deps, createEvent } = setup();
    let release: (() => void) | undefined;
    createEvent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              createEvent: { event: { id: '322222222', eventUrl: NEW_URL } },
            });
        }),
    );
    const one = recreateAndAnnounce(deps, HOST, OLD.id);
    await vi.waitFor(() => {
      expect(createEvent).toHaveBeenCalledTimes(1);
    });
    const two = await recreateAndAnnounce(deps, HOST, OLD.id);
    expect(two).toEqual({ code: 'already-recreated' });
    release?.();
    expect((await one).code).toBe('recreated');
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it('a scheduled announcement of the copy still cancels the old one, and says so', async () => {
    const { calls, alerts, run } = setup({ announce: 'scheduled' });
    await expect(run()).resolves.toMatchObject({
      code: 'recreated-scheduled',
      announce: 'scheduled',
    });
    expect(calls).toEqual(['create', 'announce', 'cancel']);
    expect(alerts()).toContain('announcement is scheduled');
  });

  it('with the cancel flag off, the old event is left and leadership is asked to cancel it', async () => {
    const { calls, alerts, run } = setup({ noCancel: true });
    await expect(run()).resolves.toMatchObject({ code: 'recreated-old-kept' });
    expect(calls).toEqual(['create', 'announce']);
    expect(alerts()).toContain('cancel the old one by hand');
    expect(alerts()).toContain('ANNOUNCE_RECREATE_CANCEL');
  });

  it('a dropped featured photo is said in the alert and the outcome', async () => {
    // The fallback creator: first call refuses the photo, second succeeds.
    const { ClientError } = await import('graphql-request');
    const photoError = new ClientError(
      {
        status: 200,
        errors: [{ message: 'Invalid photo' }] as never,
        headers: new Headers(),
      } as never,
      { query: 'mutation' },
    );
    const { createEvent, alerts, run } = setup();
    createEvent.mockRejectedValueOnce(photoError).mockResolvedValueOnce({
      createEvent: { event: { id: '322222222', eventUrl: NEW_URL } },
    });
    await expect(run()).resolves.toMatchObject({
      code: 'recreated',
      photoDropped: true,
    });
    expect(alerts()).toContain('refused the featured photo');
  });

  it('refuses when someone other than the hosts has RSVPed: nothing claimed, created or cancelled', async () => {
    const { deps, calls, recreations, run } = setup({ others: true });
    await expect(run()).resolves.toEqual({ code: 'has-rsvps' });
    expect(calls).toEqual([]);
    expect(recreations.claim).not.toHaveBeenCalled();
    expect(deps.copySource).not.toHaveBeenCalled();
  });

  it('refuses someone else’s event, one already recreated, and one Meetup cannot give (claim released)', async () => {
    await expect(
      recreateAndAnnounce(setup().deps, HOST, '999'),
    ).resolves.toEqual({ code: 'not-yours' });
    await expect(setup({ existing: '300000000' }).run()).resolves.toEqual({
      code: 'already-recreated',
    });
    const noSource = setup({ source: undefined });
    await expect(noSource.run()).resolves.toEqual({ code: 'no-source' });
    expect(noSource.calls).toEqual([]);
    expect(noSource.recreations.rows.has(OLD.id)).toBe(false);
    const notHost = setup({
      source: { ...SOURCE, eventHosts: [{ member: { id: '1' } }] },
    });
    await expect(notHost.run()).resolves.toEqual({ code: 'no-source' });
  });

  it('the copy failing to create releases the claim and leaves the old event untouched, alerted', async () => {
    const { deps, calls, recreations, alerts, run } = setup({
      create: async () => {
        throw new Error('meetup down');
      },
    });
    await expect(run()).resolves.toEqual({ code: 'create-failed' });
    expect(calls).toEqual(['create']);
    expect(recreations.rows.has(OLD.id)).toBe(false);
    expect(deps.cancelEvent).not.toHaveBeenCalled();
    expect(deps.announce).not.toHaveBeenCalled();
    expect(alerts()).toContain('old event is untouched');
    // So a retry can claim again.
    await expect(run()).resolves.toEqual({ code: 'create-failed' });
    const none = setup({
      create: async () => ({ createEvent: { event: null } }),
    });
    await expect(none.run()).resolves.toEqual({ code: 'create-failed' });
    expect(none.calls).toEqual(['create']);
    expect(none.recreations.rows.has(OLD.id)).toBe(false);
  });

  it('a copy whose announcement did not go out leaves the old event in place; the record stays', async () => {
    for (const announce of ['failed', 'unconfirmed', 'rsvps-closed'] as const) {
      const { deps, calls, recreations, alerts, run } = setup({ announce });
      // eslint-disable-next-line no-await-in-loop
      await expect(run()).resolves.toMatchObject({
        code: 'announce-failed',
        announce,
      });
      expect(calls).toEqual(['create', 'announce']);
      expect(deps.cancelEvent).not.toHaveBeenCalled();
      expect(recreations.rows.get(OLD.id)?.newEventId).toBe('322222222');
      expect(alerts()).toContain('NOT cancelled');
    }
  });

  it('the old event failing to cancel is said so; the copy and its announcement stand', async () => {
    const { alerts, run } = setup({ cancelFails: true });
    await expect(run()).resolves.toMatchObject({
      code: 'cancel-failed',
      announce: 'sent',
    });
    expect(alerts()).toContain('did not cancel the old event');
  });
});

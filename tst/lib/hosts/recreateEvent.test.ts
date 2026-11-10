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

function setup(
  options: {
    others?: boolean;
    existing?: boolean;
    source?: CopySource | undefined;
    create?: () => Promise<unknown>;
    announce?: AnnounceCode;
    cancelFails?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const recorded: [string, string, string][] = [];
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
    cancelEvent: vi.fn(async () => {
      calls.push('cancel');
      if (options.cancelFails) {
        throw new Error('meetup down');
      }
    }),
    recreations: async () => ({
      record: async (o: string, n: string, by: string) => {
        calls.push('record');
        recorded.push([o, n, by]);
        return true;
      },
      get: async () => {
        return options.existing ? { newEventId: '300000000' } : undefined;
      },
    }),
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
    recorded,
    createEvent,
    run: () => recreateAndAnnounce(deps, HOST, OLD.id),
  };
}

describe('recreateInput', () => {
  it('copies the event as it is: title, description, time, hosts, limits, photo, venue, directions', () => {
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

  it('leaves out what the source lacks', () => {
    const input = recreateInput(
      {
        ...SOURCE,
        featuredEventPhoto: null,
        venue: null,
        howToFindUs: '  ',
        maxTickets: null,
        guestLimit: null,
        duration: null,
      },
      [HOST.meetupMemberId],
    );
    expect(input).not.toHaveProperty('featuredPhotoId');
    expect(input).not.toHaveProperty('venueId');
    expect(input).not.toHaveProperty('howToFindUs');
    expect(input.rsvpSettings).toEqual(createEventTemplate.rsvpSettings);
    expect(input.duration).toBe(createEventTemplate.duration);
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
      recreatable(setup({ existing: true }).deps, HOST, OLD.id),
    ).resolves.toEqual({ ok: false, reason: 'already-recreated' });
  });
});

describe('recreateAndAnnounce', () => {
  it('creates the copy, records the link, announces it, then cancels the old one; alerts and audits', async () => {
    const { deps, calls, recorded, createEvent, run } = setup();
    const outcome = await run();
    expect(outcome).toMatchObject({
      code: 'recreated',
      announce: 'sent',
      newEvent: { id: '322222222', eventUrl: NEW_URL, title: OLD.title },
    });
    expect(calls).toEqual(['create', 'record', 'announce', 'cancel']);
    expect(recorded).toEqual([[OLD.id, '322222222', HOST.meetupMemberId]]);
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
    const alerts = JSON.stringify(vi.mocked(deps.alert).mock.calls);
    expect(alerts).toContain('recreated an event');
    expect(alerts).toContain('Ann \\\\*N\\\\*');
    // The leading bracket is escaped, as alertText does for a masked link.
    expect(alerts).toContain('\\\\[Guest Host]');
    expect(alerts).not.toMatch(/<@&|@everyone|@here/);
    expect(JSON.stringify(vi.mocked(deps.audit).mock.calls)).toContain(
      'recreated an event',
    );
  });

  it('a scheduled announcement of the copy still cancels the old one', async () => {
    const { calls, run } = setup({ announce: 'scheduled' });
    await expect(run()).resolves.toMatchObject({
      code: 'recreated',
      announce: 'scheduled',
    });
    expect(calls).toEqual(['create', 'record', 'announce', 'cancel']);
  });

  it('refuses when someone other than the hosts has RSVPed: nothing created or cancelled', async () => {
    const { deps, calls, run } = setup({ others: true });
    await expect(run()).resolves.toEqual({ code: 'has-rsvps' });
    expect(calls).toEqual([]);
    expect(deps.copySource).not.toHaveBeenCalled();
  });

  it('refuses someone else’s event, one already recreated, and one Meetup cannot give', async () => {
    await expect(
      recreateAndAnnounce(setup().deps, HOST, '999'),
    ).resolves.toEqual({ code: 'not-yours' });
    await expect(setup({ existing: true }).run()).resolves.toEqual({
      code: 'already-recreated',
    });
    const noSource = setup({ source: undefined });
    await expect(noSource.run()).resolves.toEqual({ code: 'no-source' });
    expect(noSource.calls).toEqual([]);
    const notHost = setup({
      source: { ...SOURCE, eventHosts: [{ member: { id: '1' } }] },
    });
    await expect(notHost.run()).resolves.toEqual({ code: 'no-source' });
  });

  it('the copy failing to create leaves the old event untouched, alerted', async () => {
    const { deps, calls, run } = setup({
      create: async () => {
        throw new Error('meetup down');
      },
    });
    await expect(run()).resolves.toEqual({ code: 'create-failed' });
    expect(calls).toEqual(['create']);
    expect(deps.cancelEvent).not.toHaveBeenCalled();
    expect(deps.announce).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(deps.alert).mock.calls)).toContain(
      'old event is untouched',
    );
    const none = setup({
      create: async () => ({ createEvent: { event: null } }),
    });
    await expect(none.run()).resolves.toEqual({ code: 'create-failed' });
    expect(none.calls).toEqual(['create']);
  });

  it('a copy whose announcement did not go out leaves the old event in place', async () => {
    for (const announce of ['failed', 'unconfirmed', 'rsvps-closed'] as const) {
      const { deps, calls, run } = setup({ announce });
      // eslint-disable-next-line no-await-in-loop
      await expect(run()).resolves.toMatchObject({
        code: 'announce-failed',
        announce,
      });
      expect(calls).toEqual(['create', 'record', 'announce']);
      expect(deps.cancelEvent).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(deps.alert).mock.calls)).toContain(
        'NOT cancelled',
      );
    }
  });

  it('the old event failing to cancel is said so; the copy and its announcement stand', async () => {
    const { deps, run } = setup({ cancelFails: true });
    await expect(run()).resolves.toMatchObject({
      code: 'cancel-failed',
      announce: 'sent',
    });
    expect(JSON.stringify(vi.mocked(deps.alert).mock.calls)).toContain(
      'did not cancel the old event',
    );
  });
});

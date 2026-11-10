import { describe, expect, it } from 'vitest';

import {
  ALERTABLE_KINDS,
  alertedKey,
  changeAlertEntry,
  failureAlertEntry,
  fallbackAlertEntry,
  summaryAlertEntry,
} from '../../../src/lib/eventAudit/alerts.js';
import { EventChange } from '../../../src/lib/eventAudit/types.js';
import { alertText } from '../../../src/lib/helpers/discordLogger.js';
import { eventHistoryPath } from '../../../src/lib/reports/dashboardPaths.js';

const URL_1 = 'https://www.meetup.com/g/events/311000001/';
const HISTORY =
  'https://meetup-discord-bot.herokuapp.com/dashboard/events/311000001';

const change = (overrides: Partial<EventChange> = {}): EventChange => ({
  id: 7,
  runId: 3,
  eventId: '311000001',
  detectedAt: new Date('2026-11-10T18:05:00Z'),
  kind: 'deleted',
  oldValue: {
    status: 'ACTIVE',
    startAt: '2026-12-06T03:00:00.000Z',
    rsvpYes: 23,
  },
  newValue: null,
  title: '**bold** [x](http://e) @everyone',
  startAt: new Date('2026-12-06T03:00:00Z'),
  eventUrl: URL_1,
  hosts: [
    { id: '4242', name: 'Hana <@&912474048775221270>' },
    { id: '5151', name: 'Ken' },
  ],
  rsvpYes: 23,
  waitlist: 2,
  actor: null,
  alertedAt: null,
  ...overrides,
});

describe('changeAlertEntry', () => {
  it('a deletion names the event, hosts, start and last RSVPs, with the history link and no Meetup link', () => {
    const entry = changeAlertEntry(change());
    expect(entry?.title).toBe(
      `Event deleted: ${alertText('**bold** [x](http://e) @\u200beveryone')}`,
    );
    expect(entry?.title).toContain('\\*\\*bold\\*\\* \\[x]');
    expect(entry?.description).toContain(
      'Hosts: Hana <@\u200b&912474048775221270> (4242), Ken (5151)',
    );
    expect(entry?.description).toContain('Start: Dec 5, 2026 7:00 PM');
    expect(entry?.description).toContain(
      'RSVPs at the last snapshot: 23 going, 2 on the waitlist',
    );
    expect(entry?.description).toContain(
      'Likely actor: one of the hosts above; Meetup does not say who.',
    );
    expect(entry?.description).toContain(`History: ${HISTORY}`);
    expect(entry?.description).not.toContain('meetup.com/g/events');
    expect(entry?.description).not.toMatch(/<@&\d/);
    expect(entry?.title).not.toContain('@everyone');
  });

  it('a cancellation links the Meetup event', () => {
    const entry = changeAlertEntry(
      change({
        kind: 'cancelled',
        oldValue: { status: 'ACTIVE' },
        newValue: { status: 'CANCELLED' },
        title: 'Hike',
      }),
    );
    expect(entry?.title).toBe('Event cancelled: Hike');
    expect(entry?.description).toContain(`Meetup: ${URL_1}`);
    expect(entry?.description).toContain(`History: ${HISTORY}`);
  });

  it('a host change shows before and now, from the stored values only', () => {
    const entry = changeAlertEntry(
      change({
        kind: 'host_changed',
        title: 'Hike',
        oldValue: { hosts: [{ id: '4242', name: 'Hana' }] },
        newValue: {
          hosts: [
            { id: '5151', name: 'Ken' },
            { id: 'bad', name: 'Nope' },
            'junk',
          ],
        },
      }),
    );
    expect(entry?.title).toBe('Event hosts changed: Hike');
    expect(entry?.description).toContain('Hosts before: Hana (4242)');
    expect(entry?.description).toContain('Hosts now: Ken (5151)');
    expect(entry?.description).not.toContain('Nope');
  });

  it('unknown counts and no hosts are said plainly; an empty title has a stand-in', () => {
    const entry = changeAlertEntry(
      change({
        hosts: [],
        rsvpYes: null,
        waitlist: null,
        title: '',
        eventUrl: null,
      }),
    );
    expect(entry?.title).toBe('Event deleted: (untitled event)');
    expect(entry?.description).toContain('Hosts: (no hosts listed)');
    expect(entry?.description).toContain('RSVPs at the last snapshot: unknown');
  });

  it('nothing for routine changes', () => {
    expect(changeAlertEntry(change({ kind: 'rsvp_drop' }))).toBeUndefined();
    expect(changeAlertEntry(change({ kind: 'created' }))).toBeUndefined();
    expect(ALERTABLE_KINDS).toEqual(['deleted', 'cancelled', 'host_changed']);
  });
});

describe('the other entries', () => {
  it('the summary names the count and the page', () => {
    const entry = summaryAlertEntry(14);
    expect(entry.title).toBe('Event changes: 14 in one pass');
    expect(entry.description).toContain(
      'https://meetup-discord-bot.herokuapp.com/dashboard/events',
    );
  });

  it('a failure shows the error class, never its text', () => {
    const entry = failureAlertEntry(new Error('token abc leaked'));
    expect(entry.title).toBe('Event snapshot failed');
    expect(entry.description).toContain('Error');
    expect(entry.description).not.toContain('abc');
    expect(entry.description).toContain('retries');
  });

  it('the fallback notice is fixed text', () => {
    expect(fallbackAlertEntry().title).toBe(
      'Event snapshots are running without RSVP details',
    );
  });

  it('the rate-limit key is per event and kind', () => {
    expect(alertedKey('311000001', 'deleted')).toBe(
      'event-audit-alerted-311000001-deleted',
    );
  });
});

describe('eventHistoryPath', () => {
  it('only for an all-digit id', () => {
    expect(eventHistoryPath('311000001')).toBe('/dashboard/events/311000001');
    expect(eventHistoryPath('abc')).toBeUndefined();
    expect(eventHistoryPath('')).toBeUndefined();
  });
});

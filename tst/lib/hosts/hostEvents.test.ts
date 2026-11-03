import { describe, expect, it, vi } from 'vitest';

import {
  HostEvent,
  attendanceUrl,
  groupCalendar,
  hostedEvents,
  toHostEvent,
} from '../../../src/lib/hosts/hostEvents.js';

const event = (id: string, dateTime: string, title = 'Boba'): HostEvent => ({
  id,
  title,
  dateTime,
  eventUrl: `https://www.meetup.com/g/events/${id}/`,
  type: 'food',
  hosts: [],
});

describe('hostedEvents', () => {
  it('asks Meetup for PAST events by host, newest first', async () => {
    const fetchGroupEvents = vi
      .fn()
      .mockResolvedValue([
        event('1', '2026-01-01T19:00:00-08:00'),
        event('2', '2026-03-01T19:00:00-08:00'),
      ]);
    const past = await hostedEvents(
      { fetchGroupEvents, now: () => new Date() },
      '4242',
      'past',
    );
    expect(fetchGroupEvents).toHaveBeenCalledWith({
      status: ['PAST'],
      hostId: '4242',
    });
    expect(past.map((e) => e.id)).toEqual(['2', '1']);
  });

  it('upcoming is ACTIVE, soonest first', async () => {
    const fetchGroupEvents = vi
      .fn()
      .mockResolvedValue([
        event('2', '2026-12-01T19:00:00-08:00'),
        event('1', '2026-11-10T19:00:00-08:00'),
      ]);
    const upcoming = await hostedEvents(
      { fetchGroupEvents, now: () => new Date() },
      '4242',
      'upcoming',
    );
    expect(fetchGroupEvents).toHaveBeenCalledWith({
      status: ['ACTIVE'],
      hostId: '4242',
    });
    expect(upcoming.map((e) => e.id)).toEqual(['1', '2']);
  });
});

describe('groupCalendar', () => {
  // Tuesday 2026-11-03, 00:30 Pacific (08:30 UTC).
  const now = () => new Date('2026-11-03T08:30:00Z');

  it('covers 8 weeks from this Pacific Monday', async () => {
    const fetchGroupEvents = vi.fn().mockResolvedValue([]);
    const days = await groupCalendar({ fetchGroupEvents, now });
    expect(days).toHaveLength(56);
    expect(days[0].day).toBe('2026-11-02');
    expect(days[55].day).toBe('2026-12-27');
    const filter = fetchGroupEvents.mock.calls[0][0] as {
      afterDateTime: string;
      beforeDateTime: string;
    };
    expect(filter).toMatchObject({ status: ['ACTIVE'] });
    expect(new Date(filter.afterDateTime).toISOString()).toBe(
      '2026-11-02T08:00:00.000Z',
    );
  });

  it('puts an event on its Pacific day and sets the busy level', async () => {
    const fetchGroupEvents = vi.fn().mockResolvedValue([
      // 23:30 Pacific on Nov 5 is Nov 6 in UTC.
      event('a', '2026-11-06T07:30:00Z'),
      event('b', '2026-11-07T19:00:00-08:00'),
      event('c', '2026-11-07T20:00:00-08:00'),
      event('d', '2026-11-07T21:00:00-08:00'),
      event('e', '2026-11-07T22:00:00-08:00'),
    ]);
    const days = await groupCalendar({ fetchGroupEvents, now });
    const byDay = Object.fromEntries(days.map((d) => [d.day, d]));
    expect(byDay['2026-11-05'].events.map((e) => e.id)).toEqual(['a']);
    expect(byDay['2026-11-05'].busy).toBe(1);
    expect(byDay['2026-11-07'].busy).toBe(3);
    expect(byDay['2026-11-06'].busy).toBe(0);
    expect(byDay['2026-11-26'].dates).toEqual([
      { name: 'Thanksgiving', kind: 'holiday' },
    ]);
  });

  it('a Sunday belongs to the week that started the Monday before', async () => {
    const fetchGroupEvents = vi.fn().mockResolvedValue([]);
    const days = await groupCalendar({
      fetchGroupEvents,
      now: () => new Date('2026-11-08T20:00:00Z'),
    });
    expect(days[0].day).toBe('2026-11-02');
  });
});

describe('attendanceUrl', () => {
  it('links a Meetup event to its attendee page', () => {
    expect(attendanceUrl('https://www.meetup.com/g-1/events/312345678/')).toBe(
      'https://www.meetup.com/g-1/events/312345678/attendees/',
    );
    expect(attendanceUrl('https://www.meetup.com/g-1/events/312345678')).toBe(
      'https://www.meetup.com/g-1/events/312345678/attendees/',
    );
  });

  it('refuses anything else', () => {
    expect(attendanceUrl('https://evil.example/events/1/')).toBeUndefined();
    expect(attendanceUrl('javascript:alert(1)')).toBeUndefined();
    expect(
      attendanceUrl('https://www.meetup.com/g/events/1/?x="'),
    ).toBeUndefined();
  });
});

describe('toHostEvent', () => {
  it('keeps hosts and classifies the title', () => {
    expect(
      toHostEvent({
        id: '9',
        title: '[Guest Host] Hike',
        dateTime: '2026-11-01T10:00:00-07:00',
        eventUrl: 'https://www.meetup.com/g/events/9/',
        eventHosts: [{ member: { id: '4242', name: 'Ann' } }, { member: null }],
      }),
    ).toMatchObject({ type: 'outdoors', hosts: [{ id: '4242', name: 'Ann' }] });
  });
});

describe('groupCalendar across DST', () => {
  it('asks Meetup for Pacific midnight at both ends of a fall-back window', async () => {
    const fetchGroupEvents = vi.fn().mockResolvedValue([]);
    // 2026-11-01 01:30 PDT, the morning clocks fall back.
    const days = await groupCalendar({
      fetchGroupEvents,
      now: () => new Date('2026-11-01T08:30:00Z'),
    });
    expect(days[0].day).toBe('2026-10-26');
    expect(days[55].day).toBe('2026-12-20');
    const filter = fetchGroupEvents.mock.calls[0][0] as {
      afterDateTime: string;
      beforeDateTime: string;
    };
    expect(new Date(filter.afterDateTime).toISOString()).toBe(
      '2026-10-26T07:00:00.000Z',
    );
    expect(new Date(filter.beforeDateTime).toISOString()).toBe(
      '2026-12-21T08:00:00.000Z',
    );
  });
});

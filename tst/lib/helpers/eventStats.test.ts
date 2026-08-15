import { describe, expect, it } from 'vitest';

import {
  countAttendedEvents,
  countHostedEvents,
} from '../../../src/lib/helpers/eventStats.js';

const rsvp = (memberId: string) => ({ member: { id: memberId } });
const event = (...hostIds: string[]) => ({
  eventHosts: hostIds.map((id) => ({ member: { id } })),
});

describe('countAttendedEvents', () => {
  it('counts only events the member actually rsvped to', () => {
    const rsvpsPerEvent = [
      [rsvp('me'), rsvp('other')], // attended
      [rsvp('other')], // not attended
      [], // nobody
      [rsvp('other'), rsvp('me')], // attended
    ];

    expect(countAttendedEvents(rsvpsPerEvent, 'me')).toBe(2);
  });

  it('is zero when the member attended nothing, not the event count', () => {
    const rsvpsPerEvent = [[rsvp('other')], [rsvp('other')], [rsvp('other')]];

    expect(countAttendedEvents(rsvpsPerEvent, 'me')).toBe(0);
  });
});

describe('countHostedEvents', () => {
  it('counts only events the member hosted', () => {
    const events = [event('me'), event('other'), event('other', 'me'), event()];

    expect(countHostedEvents(events, 'me')).toBe(2);
  });
});

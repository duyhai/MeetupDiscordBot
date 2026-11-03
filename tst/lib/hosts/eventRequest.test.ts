import { describe, expect, it } from 'vitest';

import {
  CopySource,
  copyDefaults,
  copySettings,
  createInputFor,
  freshSettings,
  isHostOf,
  parseRequestForm,
  titleMaxFor,
} from '../../../src/lib/hosts/eventRequest.js';
import { EventRequest } from '../../../src/lib/repositories/postgresEventRequestRepository.js';
import { createEventTemplate } from '../../../src/templates/createEventTemplate.js';

const TODAY = '2026-11-03';
const ANY_TEXT: unknown = expect.any(String);
const form = (over: Record<string, unknown> = {}) => ({
  title: 'Board game night',
  day: '2026-11-04',
  time: '19:00',
  duration: 'PT2H',
  ...over,
});

describe('parseRequestForm', () => {
  it('accepts a good form and strips host prefixes from the title', () => {
    expect(
      parseRequestForm(
        form({ title: '  [Guest Host] [Community Host] Hot pot  ' }),
        'regular',
        TODAY,
      ),
    ).toEqual({
      ok: true,
      value: {
        title: 'Hot pot',
        day: '2026-11-04',
        time: '19:00',
        duration: 'PT2H',
      },
    });
  });

  it('caps the title at 80 less the tier’s prefix', () => {
    expect(titleMaxFor('regular')).toBe(80 - '[Guest Host] '.length);
    expect(titleMaxFor('promoted')).toBe(80 - '[Community Host] '.length);
    const promotedMax = 'x'.repeat(titleMaxFor('promoted'));
    expect(
      parseRequestForm(form({ title: promotedMax }), 'promoted', TODAY),
    ).toMatchObject({ ok: true });
    expect(
      parseRequestForm(form({ title: `${promotedMax}y` }), 'promoted', TODAY),
    ).toMatchObject({ ok: false, errors: { title: ANY_TEXT } });
    // Counts characters, not UTF-16 units.
    expect(
      parseRequestForm(
        form({ title: '🎲'.repeat(titleMaxFor('regular')) }),
        'regular',
        TODAY,
      ),
    ).toMatchObject({ ok: true });
  });

  it.each([
    ['empty', ''],
    ['only a prefix', '[Guest Host] '],
    ['a line break', 'Line\nbreak'],
    ['a control character', 'Bell\u0007'],
    ['a line separator', 'Sep\u2028arator'],
  ])('refuses a title with %s', (_label, title) => {
    expect(parseRequestForm(form({ title }), 'regular', TODAY)).toMatchObject({
      ok: false,
      errors: { title: ANY_TEXT },
    });
  });

  it.each([
    ['today', TODAY],
    ['the past', '2026-10-01'],
    ['more than a year out', '2027-11-04'],
    ['not a real date', '2026-11-31'],
    ['not a date', 'tomorrow'],
  ])('refuses a day in %s', (_label, day) => {
    expect(parseRequestForm(form({ day }), 'regular', TODAY)).toMatchObject({
      ok: false,
      errors: { day: ANY_TEXT },
    });
  });

  it('accepts tomorrow and exactly a year out', () => {
    expect(
      parseRequestForm(form({ day: '2026-11-04' }), 'regular', TODAY).ok,
    ).toBe(true);
    expect(
      parseRequestForm(form({ day: '2027-11-03' }), 'regular', TODAY).ok,
    ).toBe(true);
  });

  it('refuses a time off the 15-minute steps and an unknown duration', () => {
    const result = parseRequestForm(
      form({ time: '19:10', duration: 'PT9H' }),
      'regular',
      TODAY,
    );
    expect(result).toMatchObject({
      ok: false,
      errors: { time: ANY_TEXT, duration: ANY_TEXT },
    });
  });

  it('refuses repeated fields and a missing body', () => {
    expect(
      parseRequestForm(form({ title: ['a', 'b'] }), 'regular', TODAY),
    ).toMatchObject({ ok: false, errors: { title: ANY_TEXT } });
    const empty = parseRequestForm(undefined, 'regular', TODAY);
    expect(empty.ok).toBe(false);
  });

  it('never echoes what the host typed in an error', () => {
    const result = parseRequestForm(
      form({ title: '<script>'.repeat(20), day: '<b>x</b>' }),
      'regular',
      TODAY,
    );
    expect(JSON.stringify(result)).not.toContain('<');
  });
});

const source = (over: Partial<CopySource> = {}): CopySource => ({
  id: '311111111',
  title: '[Guest Host] Sunset hike',
  description: 'Meet at the trailhead.',
  dateTime: '2026-09-12T17:40:00-07:00',
  duration: 'PT3H',
  maxTickets: 15,
  guestLimit: 2,
  howToFindUs: 'Look for the orange flag',
  featuredEventPhoto: { id: '520000001' },
  venue: { id: '27000001' },
  eventHosts: [{ member: { id: '4242' } }, { member: null }],
  ...over,
});

describe('copying an event', () => {
  it('knows who hosted it', () => {
    expect(isHostOf(source(), '4242')).toBe(true);
    expect(isHostOf(source(), '5555')).toBe(false);
    expect(isHostOf(source({ eventHosts: null }), '4242')).toBe(false);
  });

  it('starts the form from the source’s title, Pacific time and length', () => {
    expect(copyDefaults(source())).toEqual({
      title: 'Sunset hike',
      time: '17:30',
      duration: 'PT3H',
    });
    expect(copyDefaults(source({ duration: 'PT7H', title: null }))).toEqual({
      title: '',
      time: '17:30',
      duration: 'PT2H',
    });
  });

  it('keeps every setting, with no tip', () => {
    expect(copySettings(source(), 'PT3H')).toEqual({
      description: 'Meet at the trailhead.',
      duration: 'PT3H',
      rsvpLimit: 15,
      guestLimit: 2,
      featuredPhotoId: 520000001,
      venueId: '27000001',
      howToFindUs: 'Look for the orange flag',
    });
  });

  it('falls back to the template for values out of range', () => {
    const settings = copySettings(
      source({
        maxTickets: 0,
        guestLimit: 99,
        featuredEventPhoto: null,
        venue: { id: 'bad id!' },
        howToFindUs: '   ',
        description: null,
      }),
      'PT2H',
    );
    expect(settings).toMatchObject({
      description: '',
      rsvpLimit: createEventTemplate.rsvpSettings.rsvpLimit,
      guestLimit: createEventTemplate.rsvpSettings.guestLimit,
      featuredPhotoId: createEventTemplate.featuredPhotoId,
      venueId: null,
      howToFindUs: null,
    });
  });
});

describe('fresh events', () => {
  it('adds the Host Tip only for regular hosts', () => {
    expect(freshSettings('regular', 'Start small', 'PT2H').description).toMatch(
      /^💡 Host Tip: Start small 💡\n\n\*\*EVENT DETAILS\*\*/,
    );
    expect(
      freshSettings('promoted', 'Start small', 'PT2H').description,
    ).toMatch(/^\*\*EVENT DETAILS\*\*/);
  });
});

const stored = (over: Partial<EventRequest> = {}): EventRequest => ({
  id: '1',
  meetupMemberId: '4242',
  discordUserId: null,
  hostName: 'Hana',
  tier: 'regular',
  kind: 'fresh',
  sourceEventId: null,
  title: 'Hot pot',
  description: 'desc',
  startLocal: '2026-12-05T18:30',
  duration: 'PT2H30M',
  rsvpLimit: 10,
  guestLimit: 0,
  featuredPhotoId: null,
  venueId: null,
  howToFindUs: null,
  status: 'publishing',
  denyReason: null,
  failure: null,
  decidedBy: null,
  decidedAt: null,
  meetupEventId: null,
  eventUrl: null,
  version: 2,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe('createInputFor', () => {
  it('prefixes by the tier at publish and hosts the requester', () => {
    const input = createInputFor(stored({ tier: 'promoted' }), 'regular');
    expect(input).toMatchObject({
      title: '[Guest Host] Hot pot',
      description: 'desc',
      startDateTime: '2026-12-05T18:30',
      duration: 'PT2H30M',
      eventHosts: [4242],
      publishStatus: 'PUBLISHED',
      groupUrlname: createEventTemplate.groupUrlname,
      rsvpSettings: {
        ...createEventTemplate.rsvpSettings,
        rsvpLimit: 10,
        guestLimit: 0,
      },
    });
    expect(input).not.toHaveProperty('featuredPhotoId');
    expect(input).not.toHaveProperty('venueId');
    expect(input).not.toHaveProperty('howToFindUs');
    expect(createInputFor(stored(), 'promoted').title).toBe(
      '[Community Host] Hot pot',
    );
  });

  it('sets the photo, venue and directions when the request has them', () => {
    expect(
      createInputFor(
        stored({
          featuredPhotoId: 520000001,
          venueId: '27000001',
          howToFindUs: 'Orange flag',
        }),
        'regular',
      ),
    ).toMatchObject({
      featuredPhotoId: 520000001,
      venueId: '27000001',
      howToFindUs: 'Orange flag',
    });
  });

  it('does not change the shared template', () => {
    createInputFor(stored(), 'regular');
    expect(createEventTemplate.title).toBe('Organizer Event Template');
    expect(createEventTemplate.featuredPhotoId).toBe(503707686);
  });
});

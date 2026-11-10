import { describe, expect, it } from 'vitest';

import {
  countsAsAttended,
  countsAsHosted,
  hasCancelledTitle,
  hostedExclusion,
  isCancelledEvent,
  isOpenHouseEvent,
} from '../../../src/lib/helpers/countedEvents.js';

/** Every distinct past group title containing "open house" (Meetup, 2026-11-10). */
const OPEN_HOUSE_TAGGED = [
  '[Open House][Discounted Price] Seattle Bouldering Project (Poplar)',
  '[Guest Host] [Open House] Salsa & Bachata lesson + dance on Alki Beach',
  '[Guest Host] [Open House] Swing Lesson & Social @ Century No Partner Exp Needed',
  '[Guest Host][Open House] Swing @ Century Ballroom No Exp or Partner Required',
  '[Guest Host] [Open House] Salsa & Bachata @ Century No Partner or Exp needed',
  '[Open House] Pickleball',
  '[Open House][Discounted Price] Indoor Bouldering',
  '[Guest Host] Eastside Indoor Bouldering (Open House)',
  '[Open House] [Discounted Price] Indoor Bouldering',
];
const OPEN_HOUSE_UNTAGGED = 'Theodor Jacobsen Observatory Open House';

describe('cancelled', () => {
  it('reads "cancelled" and "canceled" in a title, not "cancel"', () => {
    expect(hasCancelledTitle('CANCELED: Hike')).toBe(true);
    expect(hasCancelledTitle('Trivia (cancelled)')).toBe(true);
    expect(hasCancelledTitle('How to cancel plans')).toBe(false);
  });

  it('reads Meetup’s cancelled statuses; a list without statuses goes by title', () => {
    expect(isCancelledEvent({ title: 'Hike', status: 'CANCELLED' })).toBe(true);
    expect(isCancelledEvent({ title: 'Hike', status: 'CANCELLED_PERM' })).toBe(
      true,
    );
    expect(
      isCancelledEvent({ title: 'Hike', status: 'AUTOSCHED_CANCELLED' }),
    ).toBe(true);
    expect(isCancelledEvent({ title: 'Hike', status: 'PAST' })).toBe(false);
    expect(isCancelledEvent({ title: 'Hike' })).toBe(false);
  });
});

describe('open house', () => {
  it('matches every tagged title the group has used', () => {
    for (const title of OPEN_HOUSE_TAGGED) {
      expect(isOpenHouseEvent({ title }), title).toBe(true);
    }
  });

  it('is the tag, not the words: an outing at a venue’s open house counts', () => {
    expect(isOpenHouseEvent({ title: OPEN_HOUSE_UNTAGGED })).toBe(false);
    expect(
      isOpenHouseEvent({ title: 'Burgers & Shakes Night (Open to All)' }),
    ).toBe(false);
    expect(
      isOpenHouseEvent({ title: '[Guest Host] Open Jump @ Flying Circus' }),
    ).toBe(false);
  });
});

describe('countsAsHosted / countsAsAttended', () => {
  it('a plain past event counts both ways', () => {
    const e = { title: 'Trivia Night', status: 'PAST' as const };
    expect(countsAsHosted(e)).toBe(true);
    expect(countsAsAttended(e)).toBe(true);
    expect(hostedExclusion(e)).toBeUndefined();
  });

  it('a cancelled event counts neither way', () => {
    expect(countsAsHosted({ title: 'Canceled: Hike' })).toBe(false);
    expect(countsAsAttended({ title: 'Hike', status: 'CANCELLED' })).toBe(
      false,
    );
    expect(hostedExclusion({ title: 'Canceled: Hike' })).toBe('cancelled');
  });

  it('an Open House is not hosted, but going to one is attending', () => {
    const e = { title: '[Open House] Pickleball', status: 'PAST' as const };
    expect(countsAsHosted(e)).toBe(false);
    expect(countsAsAttended(e)).toBe(true);
    expect(hostedExclusion(e)).toBe('open-house');
  });

  it('a cancelled Open House reads as cancelled first', () => {
    expect(
      hostedExclusion({
        title: '[Open House] Pickleball',
        status: 'CANCELLED',
      }),
    ).toBe('cancelled');
  });
});

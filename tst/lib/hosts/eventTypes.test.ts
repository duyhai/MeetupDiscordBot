import { describe, expect, it } from 'vitest';

import {
  classifyEventType,
  isEventType,
  stripHostPrefix,
} from '../../../src/lib/hosts/eventTypes.js';

describe('classifyEventType', () => {
  it.each([
    ['[Guest Host] Board Game Night', 'games'],
    ['Hot Pot Dinner', 'food'],
    ['Trivia and boba', 'games'],
    ['Barbecue', 'social'],
    ['[Community Host] [Guest Host] Hike at Mission Peak', 'outdoors'],
    ['Pickleball Saturday', 'active'],
    ['MUSEUM day', 'arts'],
    ['Karaoke night', 'nightlife'],
    ['Resume workshop', 'learning'],
    ['Hang out', 'social'],
    ['', 'social'],
    ['Run club', 'active'],
    ['Brunch-and-run', 'food'],
  ])('%s → %s', (title, type) => {
    expect(classifyEventType(title)).toBe(type);
  });
});

describe('stripHostPrefix', () => {
  it('removes leading host tags, repeatedly', () => {
    expect(stripHostPrefix('[Guest Host] [Community Host] Boba')).toBe('Boba');
    expect(stripHostPrefix('Boba [Guest Host]')).toBe('Boba [Guest Host]');
    expect(stripHostPrefix('[Guest Host]Boba')).toBe('Boba');
  });
});

describe('isEventType', () => {
  it('accepts the fixed types only', () => {
    expect(isEventType('games')).toBe(true);
    expect(isEventType('toString')).toBe(false);
    expect(isEventType(['games'])).toBe(false);
  });
});

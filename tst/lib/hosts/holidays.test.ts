import { describe, expect, it } from 'vitest';

import { HOLIDAYS, matchHolidays } from '../../../src/lib/hosts/holidays.js';

describe('matchHolidays', () => {
  it('names the holiday from the title, whatever day the event is on', () => {
    expect(matchHolidays('Friendsgiving Potluck')).toEqual(['Thanksgiving']);
    expect(matchHolidays('Tết Celebration at the park')).toEqual([
      'Lunar New Year',
    ]);
    expect(matchHolidays('Mooncake making night')).toEqual([
      'Mid-Autumn Festival',
    ]);
    expect(matchHolidays('Ugly Sweater Party')).toEqual(['Christmas']);
    expect(matchHolidays('NYE countdown rooftop')).toEqual(["New Year's"]);
  });

  it('a Lunar New Year title is not also New Year’s', () => {
    expect(matchHolidays('Lunar New Year dinner')).toEqual(['Lunar New Year']);
    expect(matchHolidays('Chinese New Year hot pot')).toEqual([
      'Lunar New Year',
    ]);
  });

  it('matches whole words only, ignoring case and host prefixes', () => {
    expect(matchHolidays('Holiday mixer')).toEqual([]);
    expect(matchHolidays('Tetris tournament')).toEqual([]);
    expect(matchHolidays('Eastern Sierra hike')).toEqual([]);
    expect(matchHolidays('[Guest Host] HALLOWEEN costume bar crawl')).toEqual([
      'Halloween',
    ]);
  });

  it('names every holiday a title mentions, in list order', () => {
    expect(matchHolidays('Halloween + Day of the Dead party')).toEqual([
      'Halloween',
      'Day of the Dead',
    ]);
  });

  it('an ordinary title names none', () => {
    expect(matchHolidays('Board game night')).toEqual([]);
    expect(matchHolidays('')).toEqual([]);
  });

  it('every holiday has a unique name and at least one keyword', () => {
    const names = HOLIDAYS.map((h) => h.name);
    expect(new Set(names).size).toBe(names.length);
    expect(HOLIDAYS.every((h) => h.keywords.length > 0)).toBe(true);
  });
});

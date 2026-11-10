import { describe, expect, it } from 'vitest';

import {
  REVIEW_CHECKLIST,
  checklistDetail,
  checklistLabel,
  parseChecklist,
  parseChecklistDetail,
} from '../../../src/lib/hosts/reviewChecklist.js';

describe('reviewChecklist', () => {
  it('has the five boxes leadership asked for', () => {
    expect(REVIEW_CHECKLIST.map((i) => i.key)).toEqual([
      'location',
      'photo',
      'rsvps',
      'lead-time',
      'content',
    ]);
  });

  it('reads one or several ticked boxes from a form, in order, dropping junk', () => {
    expect(parseChecklist('photo')).toEqual(['photo']);
    expect(parseChecklist(['content', 'location', 'content', 'x'])).toEqual([
      'location',
      'content',
    ]);
    expect(parseChecklist(undefined)).toEqual([]);
    expect(parseChecklist({ toString: () => 'photo' })).toEqual([]);
  });

  it('round-trips through the history detail', () => {
    const detail = checklistDetail(['location', 'rsvps']);
    expect(detail).toBe('{"checklist":["location","rsvps"]}');
    expect(parseChecklistDetail(detail)).toEqual(['location', 'rsvps']);
    expect(parseChecklistDetail(checklistDetail([]))).toEqual([]);
  });

  it('a row without a checklist, or with junk, has none', () => {
    expect(parseChecklistDetail(null)).toBeUndefined();
    expect(parseChecklistDetail('Meetup said no')).toBeUndefined();
    expect(parseChecklistDetail('{"other":1}')).toBeUndefined();
    expect(parseChecklistDetail('{not json')).toBeUndefined();
  });

  it('labels every key', () => {
    expect(checklistLabel('lead-time')).toBe('Starts 7 or more days out');
  });
});

import { keywordPattern, stripHostPrefix } from './eventTypes.js';

/**
 * Holidays and cultural celebrations, recognised from an event's title, never
 * its date: members spend the day itself with family, so the group's
 * celebration is usually on another day (Hai, PR 128 review). Leadership
 * extends this list.
 */
interface Holiday {
  name: string;
  keywords: string[];
  /** Holidays this one's keywords also match, dropped when this one matches. */
  shadows?: string[];
}

export const HOLIDAYS: readonly Holiday[] = [
  {
    name: 'Lunar New Year',
    keywords: [
      'lunar new year',
      'chinese new year',
      'cny',
      'tet',
      'tết',
      'seollal',
      'spring festival',
    ],
    shadows: ["New Year's"],
  },
  {
    name: 'Mid-Autumn Festival',
    keywords: [
      'mid-autumn',
      'mid autumn',
      'moon festival',
      'mooncake',
      'mooncakes',
      'chuseok',
      'trung thu',
    ],
  },
  { name: "New Year's", keywords: ['new year', 'new years', 'nye'] },
  {
    name: "Valentine's Day",
    keywords: ['valentine', 'valentines', 'galentine', 'galentines'],
  },
  {
    name: "St. Patrick's Day",
    keywords: [
      'st patrick',
      'st. patrick',
      'saint patrick',
      'st paddy',
      'st. paddy',
    ],
  },
  { name: 'Holi', keywords: ['holi'] },
  { name: 'Easter', keywords: ['easter'] },
  { name: 'Cinco de Mayo', keywords: ['cinco de mayo'] },
  { name: 'Eid', keywords: ['eid'] },
  { name: 'Juneteenth', keywords: ['juneteenth'] },
  {
    name: 'Fourth of July',
    keywords: ['fourth of july', '4th of july', 'july 4th', 'independence day'],
  },
  { name: 'Halloween', keywords: ['halloween', 'trick or treat'] },
  {
    name: 'Day of the Dead',
    keywords: ['day of the dead', 'dia de los muertos', 'día de los muertos'],
  },
  { name: 'Diwali', keywords: ['diwali', 'deepavali'] },
  { name: 'Thanksgiving', keywords: ['thanksgiving', 'friendsgiving'] },
  { name: 'Hanukkah', keywords: ['hanukkah', 'chanukah'] },
  {
    name: 'Christmas',
    keywords: ['christmas', 'xmas', 'secret santa', 'ugly sweater'],
  },
];

const PATTERNS = HOLIDAYS.map((h) => [h, keywordPattern(h.keywords)] as const);

/** The holidays an event's title names, in list order. */
export function matchHolidays(title: string): string[] {
  const text = stripHostPrefix(title);
  const matched = PATTERNS.filter(([, pattern]) => pattern.test(text)).map(
    ([h]) => h,
  );
  const shadowed = new Set(matched.flatMap((h) => h.shadows ?? []));
  return matched.map((h) => h.name).filter((name) => !shadowed.has(name));
}

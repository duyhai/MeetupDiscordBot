import { COMMUNITY_HOST_PREFIX, GUEST_HOST_PREFIX } from '../../constants.js';

/**
 * Meetup has no reliable event type, so a type is assigned from the title by
 * keyword (spec "History": builder's call). Order matters: the first type
 * with a matching keyword wins. Manual correction comes later.
 */
export const EVENT_TYPES = [
  'games',
  'food',
  'outdoors',
  'active',
  'arts',
  'nightlife',
  'learning',
  'social',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  games: 'Games',
  food: 'Food & drink',
  outdoors: 'Outdoors',
  active: 'Sports & fitness',
  arts: 'Arts & culture',
  nightlife: 'Nightlife',
  learning: 'Learning & careers',
  social: 'Social',
};

const KEYWORDS: Record<Exclude<EventType, 'social'>, string[]> = {
  games: [
    'board game',
    'board games',
    'game night',
    'games',
    'trivia',
    'mahjong',
    'poker',
    'escape room',
    'puzzle',
    'puzzles',
  ],
  food: [
    'dinner',
    'lunch',
    'brunch',
    'breakfast',
    'food',
    'boba',
    'cafe',
    'coffee',
    'dim sum',
    'hot pot',
    'hotpot',
    'kbbq',
    'bbq',
    'ramen',
    'potluck',
    'baking',
    'cooking',
    'restaurant',
    'tea',
  ],
  outdoors: [
    'hike',
    'hiking',
    'beach',
    'picnic',
    'park',
    'camping',
    'kayak',
    'kayaking',
    'biking',
    'bike',
    'garden',
  ],
  active: [
    'volleyball',
    'badminton',
    'basketball',
    'pickleball',
    'tennis',
    'bowling',
    'climbing',
    'bouldering',
    'yoga',
    'run',
    'running',
    'gym',
    'soccer',
    'dance',
    'dancing',
    'skating',
  ],
  arts: [
    'museum',
    'art',
    'painting',
    'pottery',
    'craft',
    'crafts',
    'movie',
    'movies',
    'film',
    'concert',
    'theater',
    'theatre',
    'book club',
    'photography',
  ],
  nightlife: [
    'karaoke',
    'bar',
    'bars',
    'drinks',
    'happy hour',
    'club',
    'rooftop',
    'wine',
  ],
  learning: [
    'workshop',
    'talk',
    'panel',
    'class',
    'networking',
    'career',
    'language',
  ],
};

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One case-insensitive, word-bounded pattern for a keyword list, so "bar"
 * never matches "Barbecue".
 */
export const keywordPattern = (words: readonly string[]): RegExp =>
  new RegExp(
    `(?:^|[^\\p{L}\\p{N}])(?:${words.map(escape).join('|')})(?=$|[^\\p{L}\\p{N}])`,
    'iu',
  );

const PATTERNS: [EventType, RegExp][] = (
  Object.entries(KEYWORDS) as [EventType, string[]][]
).map(([type, words]) => [type, keywordPattern(words)]);

/** Removes leading [Guest Host] / [Community Host] tags, however many. */
export function stripHostPrefix(title: string): string {
  let rest = title;
  for (;;) {
    const trimmed = rest.trimStart();
    const prefix = [GUEST_HOST_PREFIX, COMMUNITY_HOST_PREFIX].find((p) =>
      trimmed.startsWith(p.trimEnd()),
    );
    if (!prefix) {
      return trimmed;
    }
    rest = trimmed.slice(prefix.trimEnd().length);
  }
}

export function classifyEventType(title: string): EventType {
  const text = stripHostPrefix(title);
  return PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'social';
}

export function isEventType(value: unknown): value is EventType {
  return (
    typeof value === 'string' &&
    (EVENT_TYPES as readonly string[]).includes(value)
  );
}

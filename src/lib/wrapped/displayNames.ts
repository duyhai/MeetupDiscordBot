/**
 * Display names for the people a Wrapped names, resolved at render time and
 * kept in Redis for a day. Discord allows five guild-member reads per
 * window, so a Wrapped naming ~20 people spent 2–3 s queued behind that
 * limit on every cold render (measured 2026-11-16). The cache holds the
 * display name alone, keyed by Discord id: no Meetup id, no stats, nothing
 * that says who went with whom. Who is named is still the stored entry's
 * call (linked and present at build time); this only spares the lookup.
 *
 * Someone Discord says is not on the server is remembered as such for ten
 * minutes (a fixed marker, nothing about them), so departed companions do
 * not cost a gateway request or a REST read on every page view.
 */
import { KeyValueCache } from '../cache/base.js';

/** As long as the current year's hot copy (store.ts HOT_TTL_SEC). */
export const DISPLAY_NAME_TTL_SEC = 24 * 60 * 60;
/** "Not on the server": short, so someone who rejoins is named again soon. */
export const ABSENT_TTL_SEC = 10 * 60;
/** The absent marker: a control character, which no Discord name contains. */
export const ABSENT = '\u0000';

export function displayNameKey(discordUserId: string): string {
  return `wrapped:name:${discordUserId}`;
}

export interface ResolvedNames {
  names: Record<string, string>;
  /** Served from the bot's memory or Redis (absent markers included). */
  cached: number;
  /** Asked of Discord (found or not). */
  looked: number;
}

/**
 * The bot's answers for ids nobody had: a name; null when Discord says
 * they are not on the server; left out when it could not tell.
 */
export type NameLookup = (
  discordUserIds: string[],
) => Promise<Record<string, string | null>>;

/**
 * Each id's display name: the bot's in-memory member cache (`live`, the
 * freshest), then Redis, then `lookup` for the rest, in one call. A name
 * found is cached for a day; "not on the server" for ten minutes; an id
 * Discord could not answer for is cached not at all. Anyone without a name
 * is left out, so the page counts them. A Redis failure only costs the
 * lookup. Never throws.
 */
export async function resolveDisplayNames(
  cache: KeyValueCache,
  discordUserIds: Iterable<string>,
  lookup: NameLookup,
  live: (discordUserIds: string[]) => Record<string, string> = () => ({}),
): Promise<ResolvedNames> {
  const ids = [...new Set(discordUserIds)];
  let names: Record<string, string> = {};
  try {
    names = { ...live(ids) };
  } catch {
    // Redis and the lookup still answer.
  }
  const notLive = ids.filter((id) => names[id] === undefined);
  const fromCache = await Promise.all(
    notLive.map((id) =>
      cache.get(displayNameKey(id)).catch((): undefined => undefined),
    ),
  );
  const missing: string[] = [];
  notLive.forEach((id, i) => {
    const value = fromCache[i];
    if (value === ABSENT) {
      return;
    }
    if (typeof value === 'string' && value.length > 0) {
      names[id] = value;
    } else {
      missing.push(id);
    }
  });
  if (missing.length > 0) {
    let found: Record<string, string | null> = {};
    try {
      found = await lookup(missing);
    } catch {
      // Counted, not named.
    }
    await Promise.all(
      missing.map(async (id) => {
        const name = found[id];
        if (name === null) {
          await cache
            .set(displayNameKey(id), ABSENT, ABSENT_TTL_SEC)
            .catch(() => undefined);
          return;
        }
        if (typeof name !== 'string' || name.length === 0) {
          return;
        }
        names[id] = name;
        await cache
          .set(displayNameKey(id), name, DISPLAY_NAME_TTL_SEC)
          .catch(() => undefined);
      }),
    );
  }
  return { names, cached: ids.length - missing.length, looked: missing.length };
}

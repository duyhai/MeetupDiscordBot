/**
 * Display names for the people a Wrapped names, resolved at render time and
 * kept in Redis for a day. Discord allows five guild-member reads per
 * window, so a Wrapped naming ~20 people spent 2–3 s queued behind that
 * limit on every cold render (measured 2026-11-16). The cache holds the
 * display name alone, keyed by Discord id: no Meetup id, no stats, nothing
 * that says who went with whom. Who is named is still the stored entry's
 * call (linked and present at build time); this only spares the lookup.
 */
import { KeyValueCache } from '../cache/base.js';

/** As long as the current year's hot copy (store.ts HOT_TTL_SEC). */
export const DISPLAY_NAME_TTL_SEC = 24 * 60 * 60;

export function displayNameKey(discordUserId: string): string {
  return `wrapped:name:${discordUserId}`;
}

export interface ResolvedNames {
  names: Record<string, string>;
  /** Served from Redis. */
  cached: number;
  /** Asked of Discord (found or not). */
  looked: number;
}

/**
 * Each id's display name: Redis first, then `lookup` (the bot) for the
 * rest, in one call; a name found is cached for a day. An id with no name
 * (left the server, Discord slow or down) is left out, so it is counted,
 * and is never cached. A Redis failure only costs the lookup. Never throws.
 */
export async function resolveDisplayNames(
  cache: KeyValueCache,
  discordUserIds: Iterable<string>,
  lookup: (discordUserIds: string[]) => Promise<Record<string, string>>,
): Promise<ResolvedNames> {
  const ids = [...new Set(discordUserIds)];
  const names: Record<string, string> = {};
  const fromCache = await Promise.all(
    ids.map((id) =>
      cache.get(displayNameKey(id)).catch((): undefined => undefined),
    ),
  );
  const missing: string[] = [];
  ids.forEach((id, i) => {
    const name = fromCache[i];
    if (typeof name === 'string' && name.length > 0) {
      names[id] = name;
    } else {
      missing.push(id);
    }
  });
  if (missing.length > 0) {
    let found: Record<string, string> = {};
    try {
      found = await lookup(missing);
    } catch {
      // Counted, not named.
    }
    await Promise.all(
      missing.map(async (id) => {
        const name = found[id];
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

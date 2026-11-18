import { SafeHtml, html, memberText } from './html.js';
import { discordProfileUrl, discordUserLink } from './links.js';

/**
 * Staff display names for the moderation pages (who recorded, voided,
 * lifted or acted). Production resolves them like a Wrapped's companions
 * (lib/wrapped/displayNames.ts): the bot's member cache, then Redis for a
 * day, then Discord for the rest. Ids it cannot name are left out.
 */
export type StaffNameLookup = (
  discordUserIds: string[],
) => Promise<Record<string, string>>;

/** A page waits at most this long for names; past it, everyone is "staff member". */
export const STAFF_NAMES_BUDGET_MS = 1500;
/**
 * After a lookup times out or fails, pages skip it for this long and go
 * straight to "staff member", so a Discord outage costs one page the
 * budget, not every page.
 */
export const STAFF_NAMES_BACKOFF_MS = 90_000;

/** When the lookup may be tried again (in-process; one per lookup function). */
export class StaffNameBackoff {
  private until = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get open(): boolean {
    return this.now() >= this.until;
  }

  trip(): void {
    this.until = this.now() + STAFF_NAMES_BACKOFF_MS;
  }

  reset(): void {
    this.until = 0;
  }
}

/** One backoff per lookup function: production has one; each test its own. */
const backoffs = new WeakMap<StaffNameLookup, StaffNameBackoff>();

function backoffFor(lookup: StaffNameLookup): StaffNameBackoff {
  let backoff = backoffs.get(lookup);
  if (!backoff) {
    backoff = new StaffNameBackoff();
    backoffs.set(lookup, backoff);
  }
  return backoff;
}

/** One page asks for at most this many ids (a page lists 50 rows, a few staff each). */
export const STAFF_NAMES_MAX = 100;
/** What a link says when the name is not known. */
export const STAFF_FALLBACK = 'staff member';

const DISCORD_ID = /^[0-9]{17,20}$/;

/**
 * One lookup for every staff id a page shows, within STAFF_NAMES_BUDGET_MS.
 * Never rejects: a missing lookup, a failure or a timeout is {} (each link
 * falls back), and a failure or timeout skips the lookup for
 * STAFF_NAMES_BACKOFF_MS. Only 17-20 digit ids are asked about; a name is kept only
 * for an id that was asked and only as a non-empty string.
 */
export async function loadStaffNames(
  lookup: StaffNameLookup | undefined,
  ids: Iterable<unknown>,
  budgetMs = STAFF_NAMES_BUDGET_MS,
  backoff?: StaffNameBackoff,
): Promise<Record<string, string>> {
  const asked = [
    ...new Set(
      [...ids].filter(
        (id): id is string => typeof id === 'string' && DISCORD_ID.test(id),
      ),
    ),
  ].slice(0, STAFF_NAMES_MAX);
  if (!lookup || asked.length === 0) {
    return {};
  }
  const gate = backoff ?? backoffFor(lookup);
  if (!gate.open) {
    return {};
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
  });
  try {
    const answer = await Promise.race([
      lookup(asked).catch((): 'failed' => 'failed'),
      timeout,
    ]);
    if (answer === 'timeout' || answer === 'failed') {
      gate.trip();
      return {};
    }
    const found = answer;
    const names: Record<string, string> = {};
    for (const id of asked) {
      const name: unknown = Object.hasOwn(found, id) ? found[id] : undefined;
      if (typeof name === 'string' && name.trim() !== '') {
        names[id] = name;
      }
    }
    return names;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A staff member's Discord profile link, named by their server display name
 * when the page found it, else "staff member". A display name is the
 * member's own text: escaped and isolated (memberText), like a member name.
 */
export function staffLink(
  id: unknown,
  names: Readonly<Record<string, string>>,
): SafeHtml {
  const name =
    typeof id === 'string' && Object.hasOwn(names, id) ? names[id] : undefined;
  if (name === undefined) {
    return discordUserLink(id, STAFF_FALLBACK);
  }
  const href = discordProfileUrl(id);
  return href
    ? html`<a href="${href}" rel="noopener noreferrer" target="_blank"
        >${memberText(name)}</a
      >`
    : memberText(name);
}

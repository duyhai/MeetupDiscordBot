# Staff Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A staff-only website inside the bot's Express app where Moderators and the 1.5 Leadership Team browse every monthly report, see trends, and work the no-show list together.

**Architecture:** Server-rendered pages under `/dashboard` in `src/app.ts`, gated by Discord OAuth (`identify`) plus a live guild-role check. Report logic is extracted from the slash commands into `src/lib/reports/` so commands and dashboard share it. A scheduled in-process job (Redis claim/done lease, like the identity digest) builds monthly snapshots into Postgres with the shared organizer Meetup credential. Only the no-show workspace writes.

**Tech Stack:** TypeScript (Node ESM, imports end in `.js`), Express 5, discord.js v14 / discordx, `arctic` (Discord OAuth provider, already a dependency), `pg`, Redis via `ApplicationCache`, vitest + supertest + nock. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-staff-dashboard-design.md` (approved by Hai 2026-10-15). Executors read both.

**Rollout (revised 2026-10-15 after the lead's independent review).** Six PRs, in order: PR 1 sign-in and shell → PR 1b `/redirect` allow-list (#109) → PR 2a organizer-token critical section → PR 2 snapshots and job → PR 3 pages and backfill → PR 4 workspace. Each starts only after the previous one merges.

**Plan depth.** PR 1 is specified to the line: every step has its code. PRs 1b–4 are specified to files, interfaces, schema SQL, test names and acceptance checks, with code for the rules that are easy to get wrong. Each of them gets a full-code addendum (same format as PR 1) written at the start of that PR, against `main` as it is after the previous PR merges, because PR 1–3 change the files those PRs build on.

## Global Constraints

- Access: Discord members holding **Moderator** (`912474048775221270`) or **1.5 Leadership Team** (`1347289004932075521`). Event Organizers excluded. Administrator permission alone does not admit: the Admin role (`912473408577609778`) without either dashboard role is refused (Hai, 2026-10-15).
- OAuth: Discord OAuth2, `identify` scope only, bot's existing Discord application (`DISCORD_CLIENT_ID` / `DISCORD_SECRET`). Redirect URI: `https://meetup-discord-bot.herokuapp.com/dashboard/auth/callback`.
- Role check cached in the session for **10 minutes**, then re-checked.
- Session: signed, `HttpOnly`, `Secure`, `SameSite=Lax` cookie; state in Redis; **12-hour** absolute lifetime.
- Every state-changing request needs a CSRF token. Every dashboard response sends `Cache-Control: no-store`. Login and actions are rate-limited. Errors render a generic page; details go to logs only.
- All member-supplied text is HTML-escaped and wrapped in `<bdi>`. Profile links only from all-digit ids: `https://www.meetup.com/members/<digits>/`, `https://discord.com/users/<digits>`.
- Lists paginate at **50** rows. Thumbnails stream one image per request. 512 MB dyno: nothing assembles a whole month or whole table in memory.
- Never written to Postgres: event descriptions, tokens (other than the existing `oauth_credentials` row), DM content. Raw descriptions are only ever cached in Redis, for at most **12 hours**. A fixed label derived from one (e.g. the `paymentNote` text "description mentions payment") may be stored.
- Every `href` built from data goes through `safeHref` (only `https://www.meetup.com/…` and `https://discord.com/users/…`). Never interpolate data into unquoted attributes, `<script>` or `<style>`.
- No month build starts 17:45–19:00 UTC; link progress only in hours 16 and 19–23 UTC. The backfill refuses 17:45–19:00 UTC.
- No role or user pings anywhere in #meetup-bot-alerts (Hai, 2026-10-16): plain embeds, `allowedMentions: { parse: [] }`.
- Recording, linking and voiding suspensions in the workspace: 1.5 Leadership Team only, checked live against Discord at the moment of the action (Hai, 2026-10-16 and 2026-10-17). Moderators do everything else.
- All existing slash commands keep working with unchanged output.
- Tests: unit via `yarn test`; integration via `vitest.integration.config.ts` only against throwaway containers on unusual ports (postgres:16 on `55432`, redis:7 on `56379`), never the dev stack on 5432/6379. Stop colima afterwards if you started it.
- No production reads or writes, no Discord posts, no Meetup calls with real credentials. Never print tokens or secrets.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR descriptions end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` and carry the note: *deploys between 18:00 and 19:00 UTC restart the bot during the daily identity sweep.* No force-push, never merge.

## Prerequisites (Hai)

| Needed for | Item |
|---|---|
| PR 1 deploy | Add redirect URI `https://meetup-discord-bot.herokuapp.com/dashboard/auth/callback` to the bot's application in the Discord developer portal (OAuth2 → Redirects). Optional for local testing: `http://localhost:5000/dashboard/auth/callback`. |
| PR 1 deploy | `heroku config:set -a meetup-discord-bot DASHBOARD_SESSION_SECRET="$(openssl rand -base64 48)"` (Hai runs it; never pasted into chat). The dashboard serves a "not configured" page until it is set; the bot is unaffected. |
| — | Resolved 2026-10-15, kept as constants in `src/constants.ts` (no env vars): report-ready notice goes to #meetup-bot-alerts, the existing `BOT_ALERTS_CHANNEL_ID` (`1537755631602237473`, Hai's choice); `NO_SHOW_POLICY_URL = 'https://15genasian.notion.site/1b1176bcb5de453687cd7aa5c0cd239b'` (public, no login); `NO_SHOW_APPEAL_URL = 'https://forms.gle/tPiPYQ2DpAVZPL1T9'`. |
| PR 3 merge | Run the backfill as a one-off dyno (command in Task 3.8). |

## Review Focus

1. **Stale or forged login callback** (state replayed, opened in another browser, cookie missing): expect a generic "link expired, sign in again" page and no session. Pinned in Task 1.7 (`rejects a callback whose state does not match the login cookie`, `rejects a replayed state`).
2. **Member loses the role mid-session or leaves the server**: locked out within 10 minutes; Discord returning *Unknown Member* is a denial, Discord being down is a 503 that keeps the session. Pinned in Task 1.3 (`treats Unknown Member as denied`) and Task 1.8 (`re-checks the role after 10 minutes and destroys the session when it is gone`, `keeps the session but answers 503 when Discord is unreachable at re-check`).
3. **Hostile display names** (`<script>`, RTL override, zero-width characters) in the header now and on every page later: rendered inert and direction-isolated. Pinned in Task 1.2 and Task 1.6 (`escapes and isolates the signed-in username`).
4. **Back-dated builds of old months** (backfill, manual refresh of last year): classifications must reflect what was true at the end of that month, not today's 12-month window or later suspensions. Pinned in Task 2.3 (`classifies a finished month as of its end, ignoring later suspensions`, `refreshing a finished month after a new suspension still lists the member`).
5. **Two people acting on the same workspace card**: the second gets "someone just updated this, reload" and nothing is half-written (suspension row without workspace row or vice versa). Pinned in Task 4.1 (`refuses a stale version and writes nothing`, `rolls back the suspension when the workspace update fails`).

---

# PR 1 — Sign-in and shell

Branch `feat/dashboard-1-auth` off `main`. Draft PR against `main`.

## File structure

| File | Responsibility |
|---|---|
| `src/constants.ts` (modify) | `SERVER_ROLES.leadership` |
| `src/web/html.ts` | Escaping, `html` tagged template, `SafeHtml`, `memberText` |
| `src/web/roleGate.ts` | Which roles admit; live guild-member check |
| `src/web/cookies.ts` | Parse and serialize cookies with fixed security attributes |
| `src/web/session.ts` | Signed session id, Redis-backed session store, absolute expiry |
| `src/web/rateLimit.ts` | In-process fixed-window limiter + middleware |
| `src/web/discordOAuth.ts` | Authorize URL, code exchange (PKCE), `/users/@me` |
| `src/web/pages.ts` | Layout, home, login, error pages (strings) |
| `src/web/dashboardRouter.ts` | Routes, security headers, session gate, CSRF, error handler |
| `src/web/dashboardDeps.ts` | Builds the router from env; holds the Discord client |
| `src/app.ts`, `src/index.ts` (modify) | Mount `/dashboard`, `trust proxy`, hand over the client |
| `tst/web/*.test.ts`, `tst/web/fakeCache.ts` | Unit tests |
| `tst/integration/dashboardSession.test.ts` | Session store against throwaway Redis |

### Task 1.1: Leadership role constant

**Files:**
- Modify: `src/constants.ts` (the `SERVER_ROLES` object)
- Test: `tst/web/roleGate.test.ts` (created in Task 1.3; this task only adds the constant)

- [ ] **Step 1: Add the role id**

```ts
export const SERVER_ROLES = {
  bots: '931394368949067796',
  guest_host: '912473798085836821',
  ladies_lounge: '935435362984161292',
  gents_lounge: '1336180499231670374',
  // 1.5 Leadership Team: admitted to the staff dashboard with moderators.
  leadership: '1347289004932075521',
  moderator: '912474048775221270',
  onboarding: '932906028725571594',
  organizer: '912474170594582568',
};
```

Id read from the Discord API (guild roles) on 2026-10-15. `ServerRoles` widens automatically; `requireModOrOrganizer` defaults are unchanged.

- [ ] **Step 2: Run the suite** — `yarn test` → all pass (nothing reads the key yet).

- [ ] **Step 3: Commit** — `git add src/constants.ts && git commit -m "Add the 1.5 Leadership Team role id"` (+ trailer).

### Task 1.2: HTML escaping and templating

**Files:**
- Create: `src/web/html.ts`
- Test: `tst/web/html.test.ts`

**Interfaces:**
- Produces: `class SafeHtml { readonly value: string }`, `escapeHtml(input: string): string`, `html(strings, ...values: HtmlValue[]): SafeHtml`, `memberText(text: string): SafeHtml`, `safeHref(url: string): string | undefined`, `type HtmlValue = SafeHtml | string | number | null | undefined | false | HtmlValue[]`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';

import {
  SafeHtml,
  escapeHtml,
  html,
  memberText,
  safeHref,
} from '../../src/web/html.js';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('html', () => {
  it('escapes interpolated strings and numbers', () => {
    expect(html`<p>${'<script>'} ${3}</p>`.value).toBe(
      '<p>&lt;script&gt; 3</p>',
    );
  });

  it('inserts SafeHtml unescaped and flattens arrays', () => {
    const items = ['<a>', 'b'].map((x) => html`<li>${x}</li>`);
    expect(html`<ul>${items}</ul>`.value).toBe(
      '<ul><li>&lt;a&gt;</li><li>b</li></ul>',
    );
  });

  it('renders null, undefined and false as nothing', () => {
    expect(html`a${null}b${undefined}c${false}d`.value).toBe('abcd');
  });

  it('returns a SafeHtml', () => {
    expect(html`x`).toBeInstanceOf(SafeHtml);
  });
});

describe('safeHref', () => {
  it('allows Meetup pages and Discord user profiles over https', () => {
    expect(safeHref('https://www.meetup.com/members/123/')).toBe(
      'https://www.meetup.com/members/123/',
    );
    expect(safeHref('https://www.meetup.com/1-5genasians/events/9/')).toBe(
      'https://www.meetup.com/1-5genasians/events/9/',
    );
    expect(safeHref('https://discord.com/users/123456789012345678')).toBe(
      'https://discord.com/users/123456789012345678',
    );
  });

  it('refuses everything else', () => {
    [
      'javascript:alert(1)',
      'http://www.meetup.com/members/1/',
      'https://www.meetup.com.evil.example/',
      'https://www.meetup.com@evil.example/',
      'https://user:pw@www.meetup.com/',
      'https://www.meetup.com:8443/',
      'https://discord.com/invite/abc',
      'https://evil.example/',
      '/dashboard',
      'not a url',
    ].forEach((url) => expect(safeHref(url)).toBeUndefined());
  });
});

describe('memberText', () => {
  it('escapes and isolates direction', () => {
    expect(memberText('‮evil<b>').value).toBe(
      '<bdi>‮evil&lt;b&gt;</bdi>',
    );
  });
});
```

- [ ] **Step 2: Run** `yarn test tst/web/html.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Server-side HTML for the staff dashboard. Every interpolated value is
 * escaped unless it is already SafeHtml, so a page can only emit markup it
 * wrote itself: member names, event titles and notes are attacker-controlled.
 */
export class SafeHtml {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

export type HtmlValue =
  | SafeHtml
  | string
  | number
  | null
  | undefined
  | false
  | HtmlValue[];

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(render).join('');
  }
  if (value instanceof SafeHtml) {
    return value.value;
  }
  return escapeHtml(String(value));
}

export function html(
  strings: TemplateStringsArray,
  ...values: HtmlValue[]
): SafeHtml {
  let out = strings[0];
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1];
  });
  return new SafeHtml(out);
}

/**
 * Member-supplied text: escaped, and wrapped in <bdi> so a right-to-left
 * override in a name cannot reorder the text around it.
 */
export function memberText(text: string): SafeHtml {
  return html`<bdi>${text}</bdi>`;
}

const LINK_TARGETS = [
  { host: 'www.meetup.com', pathPrefix: '/' },
  { host: 'discord.com', pathPrefix: '/users/' },
];

/**
 * The only outbound links a dashboard page may render. Event URLs and
 * profile URLs come from Meetup data, so they are checked here rather than
 * trusted: anything that isn't plain https to one of these places is
 * dropped, and the caller renders the text without a link.
 */
export function safeHref(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    return undefined;
  }
  const allowed = LINK_TARGETS.some(
    ({ host, pathPrefix }) =>
      parsed.hostname === host && parsed.pathname.startsWith(pathPrefix),
  );
  return allowed ? parsed.href : undefined;
}
```

- [ ] **Step 4: Run** `yarn test tst/web/html.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add src/web/html.ts tst/web/html.test.ts && git commit -m "Add escaping HTML templating for the dashboard"`.

### Task 1.3: Role gate

**Files:**
- Create: `src/web/roleGate.ts`
- Test: `tst/web/roleGate.test.ts`

**Interfaces:**
- Consumes: `SERVER_ROLES.moderator`, `SERVER_ROLES.leadership`, `GUILD_ID` from `src/constants.ts`.
- Produces: `DASHBOARD_ROLE_IDS: string[]`, `hasDashboardRole(roleIds: Iterable<string>): boolean`, `type AccessCheck = (discordUserId: string) => Promise<boolean>`, `class DashboardUnavailableError extends Error`, `discordAccessCheck(getClient: () => Client | undefined): AccessCheck`.

- [ ] **Step 1: Write the failing tests**

```ts
import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { GUILD_ID, SERVER_ROLES } from '../../src/constants.js';
import {
  DashboardUnavailableError,
  discordAccessCheck,
  hasDashboardRole,
} from '../../src/web/roleGate.js';

// Admin role: carries the Administrator permission, but is not a dashboard
// role. Hai decided (2026-10-15) that admins without Moderator or 1.5
// Leadership Team are refused.
const ADMIN_ROLE_ID = '912473408577609778';

const memberWith = (roleIds: string[], isAdministrator = false) => ({
  roles: { cache: new Map(roleIds.map((id) => [id, {}])) },
  permissions: { has: vi.fn().mockReturnValue(isAdministrator) },
});

const clientReturning = (fetchMember: ReturnType<typeof vi.fn>) => {
  const guildsFetch = vi.fn().mockResolvedValue({
    members: { fetch: fetchMember },
  });
  return { client: { guilds: { fetch: guildsFetch } }, guildsFetch };
};

const unknownMember = () =>
  new DiscordAPIError(
    { code: RESTJSONErrorCodes.UnknownMember, message: 'Unknown Member' },
    RESTJSONErrorCodes.UnknownMember,
    404,
    'GET',
    '/guilds/x/members/y',
    {},
  );

describe('hasDashboardRole', () => {
  it('admits moderators', () => {
    expect(hasDashboardRole([SERVER_ROLES.moderator])).toBe(true);
  });
  it('admits the 1.5 Leadership Team', () => {
    expect(hasDashboardRole([SERVER_ROLES.leadership])).toBe(true);
  });
  it('refuses Event Organizers without either role', () => {
    expect(hasDashboardRole([SERVER_ROLES.organizer])).toBe(false);
  });
  it('refuses no roles', () => {
    expect(hasDashboardRole([])).toBe(false);
  });
  it('refuses the Admin role on its own', () => {
    expect(hasDashboardRole([ADMIN_ROLE_ID])).toBe(false);
  });
});

describe('discordAccessCheck', () => {
  it('fetches the member fresh from the configured guild', async () => {
    const fetchMember = vi
      .fn()
      .mockResolvedValue(memberWith([SERVER_ROLES.moderator]));
    const { client, guildsFetch } = clientReturning(fetchMember);
    const check = discordAccessCheck(() => client as never);

    await expect(check('111111111111111111')).resolves.toBe(true);
    expect(guildsFetch).toHaveBeenCalledWith(GUILD_ID);
    expect(fetchMember).toHaveBeenCalledWith({
      user: '111111111111111111',
      force: true,
    });
  });

  it('denies a member without a dashboard role', async () => {
    const { client } = clientReturning(
      vi.fn().mockResolvedValue(memberWith([SERVER_ROLES.organizer])),
    );
    await expect(
      discordAccessCheck(() => client as never)('1'),
    ).resolves.toBe(false);
  });

  it('refuses a member with only the Admin role and the Administrator permission', async () => {
    const { client } = clientReturning(
      vi.fn().mockResolvedValue(memberWith([ADMIN_ROLE_ID], true)),
    );
    await expect(
      discordAccessCheck(() => client as never)('1'),
    ).resolves.toBe(false);
  });

  it('treats Unknown User as denied', async () => {
    const unknownUser = new DiscordAPIError(
      { code: RESTJSONErrorCodes.UnknownUser, message: 'Unknown User' },
      RESTJSONErrorCodes.UnknownUser,
      404,
      'GET',
      '/guilds/x/members/y',
      {},
    );
    const { client } = clientReturning(vi.fn().mockRejectedValue(unknownUser));
    await expect(
      discordAccessCheck(() => client as never)('1'),
    ).resolves.toBe(false);
  });

  it('treats Unknown Member as denied', async () => {
    const { client } = clientReturning(
      vi.fn().mockRejectedValue(unknownMember()),
    );
    await expect(
      discordAccessCheck(() => client as never)('1'),
    ).resolves.toBe(false);
  });

  it('propagates other Discord failures so callers fail closed with a retry', async () => {
    const { client } = clientReturning(
      vi.fn().mockRejectedValue(new Error('gateway down')),
    );
    await expect(discordAccessCheck(() => client as never)('1')).rejects.toThrow(
      'gateway down',
    );
  });

  it('is unavailable before the Discord client is ready', async () => {
    await expect(discordAccessCheck(() => undefined)('1')).rejects.toBeInstanceOf(
      DashboardUnavailableError,
    );
  });
});
```

- [ ] **Step 2: Run** `yarn test tst/web/roleGate.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import { Client, DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';

import { GUILD_ID, SERVER_ROLES } from '../constants.js';

/**
 * Who may use the staff dashboard: Moderators and the 1.5 Leadership Team.
 * Event Organizers are deliberately excluded, matching the moderation
 * commands, and so is the Administrator permission on its own: the dashboard
 * shows disciplinary records, and the approved spec names roles only.
 */
export const DASHBOARD_ROLE_IDS = [
  SERVER_ROLES.moderator,
  SERVER_ROLES.leadership,
];

export function hasDashboardRole(roleIds: Iterable<string>): boolean {
  for (const id of roleIds) {
    if (DASHBOARD_ROLE_IDS.includes(id)) {
      return true;
    }
  }
  return false;
}

export type AccessCheck = (discordUserId: string) => Promise<boolean>;

/** The bot is not logged in to Discord yet, so no one can be checked. */
export class DashboardUnavailableError extends Error {}

/**
 * Asks Discord, not the member cache: `force` bypasses discord.js's cache so
 * a role removed a minute ago is already gone here. A member who left the
 * server (Unknown Member) is a plain denial; any other failure propagates so
 * the caller can refuse with "try again" instead of guessing.
 */
export function discordAccessCheck(
  getClient: () => Client | undefined,
): AccessCheck {
  return async (discordUserId) => {
    const client = getClient();
    if (!client) {
      throw new DashboardUnavailableError('Discord client is not ready');
    }
    const guild = await client.guilds.fetch(GUILD_ID);
    try {
      const member = await guild.members.fetch({
        user: discordUserId,
        force: true,
      });
      return hasDashboardRole(member.roles.cache.keys());
    } catch (error: unknown) {
      if (
        error instanceof DiscordAPIError &&
        (error.code === RESTJSONErrorCodes.UnknownMember ||
          error.code === RESTJSONErrorCodes.UnknownUser)
      ) {
        return false;
      }
      throw error;
    }
  };
}
```

If the `DiscordAPIError` constructor signature in the installed discord.js differs from the test helper, adjust only the test helper (check `node_modules/@discordjs/rest/dist/index.d.ts`).

- [ ] **Step 4: Run** `yarn test tst/web/roleGate.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add src/web/roleGate.ts tst/web/roleGate.test.ts && git commit -m "Gate the dashboard on Moderator or 1.5 Leadership Team"`.

### Task 1.4: Cookies and the session store

**Files:**
- Create: `src/web/cookies.ts`, `src/web/session.ts`, `tst/web/fakeCache.ts`
- Test: `tst/web/cookies.test.ts`, `tst/web/session.test.ts`, `tst/integration/dashboardSession.test.ts`

**Interfaces:**
- Consumes: `KeyValueCache` from `src/lib/cache/base.ts`.
- Produces:
  - `parseCookies(header: string | undefined): Map<string, string>`
  - `serializeCookie(name: string, value: string, opts: { path: string; maxAgeSec?: number }): string` (always `HttpOnly; Secure; SameSite=Lax`)
  - `clearCookie(name: string, path: string): string`
  - `SESSION_COOKIE = 'dash_sid'`, `SESSION_TTL_SEC = 43200`, `ROLE_RECHECK_MS = 600000`
  - `interface DashboardSession { userId: string; username: string; csrfToken: string; createdAt: number; roleCheckedAt: number }`
  - `signSessionId(sid: string, secret: string): string`, `verifySignedSessionId(value: string, secret: string): string | undefined`
  - `class SessionStore { constructor(cache: KeyValueCache, now?: () => number); create(user: { userId: string; username: string }): Promise<{ sid: string; session: DashboardSession }>; get(sid: string): Promise<DashboardSession | undefined>; markRoleChecked(sid: string, session: DashboardSession): Promise<boolean>; destroy(sid: string): Promise<void> }` (`markRoleChecked` returns false when the session was destroyed meanwhile)
  - `safeEqual(a: string, b: string): boolean`
  - Test helper `class FakeCache implements KeyValueCache` with `ttls: Map<string, number>`.

- [ ] **Step 1: Write the fake cache**

```ts
// tst/web/fakeCache.ts
import { KeyValueCache } from '../../src/lib/cache/base.js';

/** Map-backed cache that records each key's TTL for assertions. */
export class FakeCache implements KeyValueCache {
  readonly values = new Map<string, string>();

  readonly ttls = new Map<string, number | undefined>();

  async get(key: string) {
    return this.values.get(key);
  }

  async set(key: string, value: string, ttlSec?: number) {
    this.values.set(key, value);
    this.ttls.set(key, ttlSec);
  }

  async exclusive_set(key: string, value: string, ttlSec?: number) {
    if (this.values.has(key)) {
      return false;
    }
    await this.set(key, value, ttlSec);
    return true;
  }

  async remove(key: string) {
    this.values.delete(key);
    this.ttls.delete(key);
  }
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tst/web/cookies.test.ts
import { describe, expect, it } from 'vitest';

import {
  clearCookie,
  parseCookies,
  serializeCookie,
} from '../../src/web/cookies.js';

describe('parseCookies', () => {
  it('parses name=value pairs and keeps the first of duplicates', () => {
    const cookies = parseCookies('a=1; b=two%20words; a=3');
    expect(cookies.get('a')).toBe('1');
    expect(cookies.get('b')).toBe('two words');
  });
  it('tolerates a missing header and malformed encoding', () => {
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies('x=%E0%A4%A').get('x')).toBe('%E0%A4%A');
  });
});

describe('serializeCookie', () => {
  it('always sets HttpOnly, Secure and SameSite=Lax', () => {
    expect(serializeCookie('s', 'v', { path: '/dashboard', maxAgeSec: 60 })).toBe(
      's=v; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=60',
    );
  });
  it('clears with Max-Age=0', () => {
    expect(clearCookie('s', '/dashboard')).toBe(
      's=; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    );
  });
});
```

```ts
// tst/web/session.test.ts
import { describe, expect, it } from 'vitest';

import {
  SESSION_TTL_SEC,
  SessionStore,
  safeEqual,
  signSessionId,
  verifySignedSessionId,
} from '../../src/web/session.js';
import { FakeCache } from './fakeCache.js';

const SECRET = 'x'.repeat(48);

describe('signed session ids', () => {
  it('round-trips a signed id', () => {
    expect(verifySignedSessionId(signSessionId('abc', SECRET), SECRET)).toBe(
      'abc',
    );
  });
  it('rejects a tampered id, a tampered mac, another secret, and garbage', () => {
    const signed = signSessionId('abc', SECRET);
    const [, mac] = signed.split('.');
    expect(verifySignedSessionId(`abd.${mac}`, SECRET)).toBeUndefined();
    expect(verifySignedSessionId(`abc.${mac}x`, SECRET)).toBeUndefined();
    expect(verifySignedSessionId(signed, 'y'.repeat(48))).toBeUndefined();
    expect(verifySignedSessionId('no-dot', SECRET)).toBeUndefined();
    expect(verifySignedSessionId('.mac', SECRET)).toBeUndefined();
  });
});

describe('safeEqual', () => {
  it('compares by value, including different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('SessionStore', () => {
  it('creates a session with fresh random ids and a 12-hour TTL', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache, () => 1_000);
    const a = await store.create({ userId: '1', username: 'A' });
    const b = await store.create({ userId: '1', username: 'A' });
    expect(a.sid).not.toBe(b.sid);
    expect(a.session.csrfToken).not.toBe(b.session.csrfToken);
    expect(a.session.csrfToken.length).toBeGreaterThanOrEqual(43);
    expect([...cache.ttls.values()]).toEqual([SESSION_TTL_SEC, SESSION_TTL_SEC]);
    await expect(store.get(a.sid)).resolves.toEqual(a.session);
  });

  it('never stores the raw session id as the cache key', async () => {
    const cache = new FakeCache();
    const { sid } = await new SessionStore(cache).create({
      userId: '1',
      username: 'A',
    });
    expect([...cache.values.keys()].some((key) => key.includes(sid))).toBe(
      false,
    );
  });

  it('expires 12 hours after creation even if the cache still holds it', async () => {
    let now = 0;
    const cache = new FakeCache();
    const store = new SessionStore(cache, () => now);
    const { sid } = await store.create({ userId: '1', username: 'A' });
    now = SESSION_TTL_SEC * 1000;
    await expect(store.get(sid)).resolves.toBeUndefined();
    expect(cache.values.size).toBe(0);
  });

  it('marks the role check without extending the lifetime', async () => {
    let now = 0;
    const cache = new FakeCache();
    const store = new SessionStore(cache, () => now);
    const { sid, session } = await store.create({ userId: '1', username: 'A' });
    now = 60 * 60 * 1000;
    await store.markRoleChecked(sid, session);
    expect((await store.get(sid))?.roleCheckedAt).toBe(now);
    expect([...cache.ttls.values()]).toEqual([SESSION_TTL_SEC - 3600]);
  });

  it('does not resurrect a session destroyed during the re-check', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache);
    const { sid, session } = await store.create({ userId: '1', username: 'A' });
    await store.destroy(sid);
    await expect(store.markRoleChecked(sid, session)).resolves.toBe(false);
    expect(cache.values.size).toBe(0);
  });

  it('ignores a corrupt or wrong-shaped record', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache);
    const { sid } = await store.create({ userId: '1', username: 'A' });
    const [key] = cache.values.keys();
    await cache.set(key, '{"userId":5}');
    await expect(store.get(sid)).resolves.toBeUndefined();
    await cache.set(key, 'not json');
    await expect(store.get(sid)).resolves.toBeUndefined();
  });

  it('destroys a session', async () => {
    const cache = new FakeCache();
    const store = new SessionStore(cache);
    const { sid } = await store.create({ userId: '1', username: 'A' });
    await store.destroy(sid);
    await expect(store.get(sid)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run** `yarn test tst/web/cookies.test.ts tst/web/session.test.ts` → FAIL, modules not found.

- [ ] **Step 4: Implement**

```ts
// src/web/cookies.ts
/**
 * Minimal cookie handling for the dashboard. Every cookie it sets carries
 * the same attributes, so a route cannot forget one: HttpOnly (no script
 * access), Secure (HTTPS only; browsers also accept it on localhost), and
 * SameSite=Lax (not sent on cross-site POSTs).
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (cookies.has(name)) {
      continue;
    }
    const raw = part.slice(eq + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // Keep the raw value: a malformed cookie simply won't verify.
    }
    cookies.set(name, value);
  }
  return cookies;
}

export function serializeCookie(
  name: string,
  value: string,
  { path, maxAgeSec }: { path: string; maxAgeSec?: number },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];
  if (maxAgeSec !== undefined) {
    parts.push(`Max-Age=${maxAgeSec}`);
  }
  return parts.join('; ');
}

export function clearCookie(name: string, path: string): string {
  return serializeCookie(name, '', { path, maxAgeSec: 0 });
}
```

```ts
// src/web/session.ts
import crypto from 'crypto';

import { KeyValueCache } from '../lib/cache/base.js';

export const SESSION_COOKIE = 'dash_sid';
export const SESSION_TTL_SEC = 12 * 60 * 60;
/** Losing the role locks someone out within this long. */
export const ROLE_RECHECK_MS = 10 * 60 * 1000;

export interface DashboardSession {
  userId: string;
  username: string;
  csrfToken: string;
  /** Epoch ms. The lifetime is absolute from here, never extended. */
  createdAt: number;
  roleCheckedAt: number;
}

const randomToken = () => crypto.randomBytes(32).toString('base64url');

/**
 * Keyed by a hash of the id, so whoever can read Redis still cannot replay a
 * session cookie from what is stored there.
 */
const sessionKey = (sid: string) =>
  `dashboard-session-${crypto.createHash('sha256').update(sid).digest('hex')}`;

const mac = (sid: string, secret: string) =>
  crypto.createHmac('sha256', secret).update(sid).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function signSessionId(sid: string, secret: string): string {
  return `${sid}.${mac(sid, secret)}`;
}

export function verifySignedSessionId(
  value: string,
  secret: string,
): string | undefined {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  const sid = value.slice(0, dot);
  return safeEqual(value.slice(dot + 1), mac(sid, secret)) ? sid : undefined;
}

function isSession(value: unknown): value is DashboardSession {
  const v = value as Partial<DashboardSession> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.userId === 'string' &&
    typeof v.username === 'string' &&
    typeof v.csrfToken === 'string' &&
    typeof v.createdAt === 'number' &&
    typeof v.roleCheckedAt === 'number'
  );
}

export class SessionStore {
  constructor(
    private readonly cache: KeyValueCache,
    private readonly now: () => number = Date.now,
  ) {}

  async create(user: {
    userId: string;
    username: string;
  }): Promise<{ sid: string; session: DashboardSession }> {
    const sid = randomToken();
    const at = this.now();
    const session: DashboardSession = {
      ...user,
      csrfToken: randomToken(),
      createdAt: at,
      roleCheckedAt: at,
    };
    await this.cache.set(
      sessionKey(sid),
      JSON.stringify(session),
      SESSION_TTL_SEC,
    );
    return { sid, session };
  }

  async get(sid: string): Promise<DashboardSession | undefined> {
    const raw = await this.cache.get(sessionKey(sid));
    if (!raw) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isSession(parsed)) {
      return undefined;
    }
    if (this.now() - parsed.createdAt >= SESSION_TTL_SEC * 1000) {
      await this.destroy(sid);
      return undefined;
    }
    return parsed;
  }

  /**
   * Re-reads before writing, so a logout that lands while Discord is being
   * asked about roles is not undone by this write. KeyValueCache has no
   * SET ... XX; the remaining window is one Redis round trip.
   */
  async markRoleChecked(
    sid: string,
    session: DashboardSession,
  ): Promise<boolean> {
    const at = this.now();
    const remainingSec = Math.ceil(
      (session.createdAt + SESSION_TTL_SEC * 1000 - at) / 1000,
    );
    if (remainingSec <= 0) {
      await this.destroy(sid);
      return false;
    }
    if (!(await this.cache.get(sessionKey(sid)))) {
      return false;
    }
    await this.cache.set(
      sessionKey(sid),
      JSON.stringify({ ...session, roleCheckedAt: at }),
      remainingSec,
    );
    return true;
  }

  async destroy(sid: string): Promise<void> {
    await this.cache.remove(sessionKey(sid));
  }
}
```

- [ ] **Step 5: Run** `yarn test tst/web/cookies.test.ts tst/web/session.test.ts` → PASS.

- [ ] **Step 6: Integration test against throwaway Redis**

```ts
// tst/integration/dashboardSession.test.ts
import { describe, expect, it } from 'vitest';

import { RedisCache } from '../../src/lib/cache/redisCache.js';
import { SESSION_TTL_SEC, SessionStore } from '../../src/web/session.js';

const REDIS_AVAILABLE = Boolean(process.env.REDISCLOUD_URL);

(REDIS_AVAILABLE ? describe : describe.skip)('SessionStore on Redis', () => {
  it('round-trips a session and destroys it', async () => {
    const store = new SessionStore(await RedisCache.instance());
    const { sid, session } = await store.create({ userId: '1', username: 'A' });
    await expect(store.get(sid)).resolves.toEqual(session);
    await store.destroy(sid);
    await expect(store.get(sid)).resolves.toBeUndefined();
  });

  it('sets a TTL no longer than the session lifetime', async () => {
    const cache = await RedisCache.instance();
    const store = new SessionStore(cache);
    await store.create({ userId: '2', username: 'B' });
    // RedisCache has no TTL getter; reach the client for the assertion only.
    const client = (cache as unknown as { client: { keys(p: string): Promise<string[]>; ttl(k: string): Promise<number> } }).client;
    const [key] = await client.keys('dashboard-session-*');
    const ttl = await client.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SEC);
  });
});
```

Run against a throwaway container (never 6379):

```bash
docker run -d --rm --name dash-redis-test -p 127.0.0.1:56379:6379 redis:7
```
```bash
REDISCLOUD_URL=redis://127.0.0.1:56379 yarn vitest run --config vitest.integration.config.ts tst/integration/dashboardSession.test.ts
```
```bash
docker stop dash-redis-test
```

Expected: 2 passed. (If colima was started for this, `colima stop` afterwards.)

- [ ] **Step 7: Commit** — `git add src/web/cookies.ts src/web/session.ts tst/web/fakeCache.ts tst/web/cookies.test.ts tst/web/session.test.ts tst/integration/dashboardSession.test.ts && git commit -m "Add signed, Redis-backed dashboard sessions"`.

### Task 1.5: Rate limiter

**Files:**
- Create: `src/web/rateLimit.ts`
- Test: `tst/web/rateLimit.test.ts`

**Interfaces:**
- Produces: `class FixedWindowLimiter { constructor(limit: number, windowMs: number, now?: () => number, maxKeys?: number); take(key: string): boolean; retryAfterSec(key: string): number }`.

In-process on purpose: the app runs on one web dyno, and Redis has no atomic increment in `KeyValueCache`. Note this assumption in the PR.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';

import { FixedWindowLimiter } from '../../src/web/rateLimit.js';

describe('FixedWindowLimiter', () => {
  it('allows up to the limit per key per window', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(2, 1000, () => now);
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([
      true,
      true,
      false,
    ]);
    expect(limiter.take('b')).toBe(true);
    now = 1000;
    expect(limiter.take('a')).toBe(true);
  });

  it('reports seconds until the window resets', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 10_000, () => now);
    limiter.take('a');
    now = 2_500;
    expect(limiter.retryAfterSec('a')).toBe(8);
  });

  it('stays bounded under many distinct keys', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, () => 0, 3);
    ['a', 'b', 'c', 'd', 'e'].forEach((key) => limiter.take(key));
    expect(limiter.size).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
/**
 * Fixed-window request limiter, per key (an IP for sign-in, a Discord user
 * id for actions). Kept in process: the bot runs on a single web dyno. The
 * map is capped so a flood of distinct keys cannot grow memory on a dyno
 * with an R14 history; when full it drops expired windows, then everything.
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  get size(): number {
    return this.hits.size;
  }

  take(key: string): boolean {
    const at = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= at) {
      if (!entry && this.hits.size >= this.maxKeys) {
        this.evict(at);
      }
      entry = { count: 0, resetAt: at + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  retryAfterSec(key: string): number {
    const entry = this.hits.get(key);
    return entry ? Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000)) : 1;
  }

  private evict(at: number) {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= at) {
        this.hits.delete(key);
      }
    }
    if (this.hits.size >= this.maxKeys) {
      this.hits.clear();
    }
  }
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"Add an in-process rate limiter for dashboard routes"`.

### Task 1.6: Discord OAuth helpers and pages

**Files:**
- Create: `src/web/discordOAuth.ts`, `src/web/pages.ts`
- Test: `tst/web/discordOAuth.test.ts`, `tst/web/pages.test.ts`

**Interfaces:**
- Consumes: `Discord`, `generateState`, `generateCodeVerifier` from `arctic`; `boundedFetch`; `Configuration.discord`; `BASE_DISCORD_BOT_URL`; `html`, `memberText`.
- Produces:
  - `dashboardRedirectUri(): string`
  - `buildDashboardLoginUrl(state: string, codeVerifier: string): string`
  - `exchangeDashboardCode(code: string, codeVerifier: string): Promise<string>` (access token)
  - `fetchDiscordIdentity(accessToken: string): Promise<{ id: string; username: string }>`
  - `interface PageUser { username: string; csrfToken: string }`
  - `layout(opts: { title: string; nonce: string; user?: PageUser; body: SafeHtml }): string`
  - `homePage(user: PageUser, nonce: string): string`
  - `loginPage(nonce: string, notice?: string): string`
  - `errorPage(status: 400 | 403 | 404 | 429 | 500 | 502 | 503, nonce: string): string`

- [ ] **Step 1: Write the failing tests**

```ts
// tst/web/discordOAuth.test.ts
import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import { BASE_DISCORD_BOT_URL } from '../../src/constants.js';
import {
  buildDashboardLoginUrl,
  dashboardRedirectUri,
  exchangeDashboardCode,
  fetchDiscordIdentity,
} from '../../src/web/discordOAuth.js';

afterEach(() => nock.cleanAll());

describe('dashboard Discord OAuth', () => {
  it('uses the dashboard callback as the redirect URI', () => {
    expect(dashboardRedirectUri()).toBe(
      `${BASE_DISCORD_BOT_URL}/dashboard/auth/callback`,
    );
  });

  // BASE_DISCORD_BOT_URL is read at import time and flips to localhost when
  // TS_NODE_DEBUG is set, so the production value is only asserted without it.
  it.skipIf(Boolean(process.env.TS_NODE_DEBUG))(
    'is the URI registered in the Discord portal',
    () => {
      expect(dashboardRedirectUri()).toBe(
        'https://meetup-discord-bot.herokuapp.com/dashboard/auth/callback',
      );
    },
  );

  it('asks for identify only, with state and a PKCE challenge', () => {
    const url = new URL(buildDashboardLoginUrl('state-1', 'v'.repeat(43)));
    expect(url.origin + url.pathname).toBe(
      'https://discord.com/oauth2/authorize',
    );
    expect(url.searchParams.get('scope')).toBe('identify');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(dashboardRedirectUri());
  });

  it('exchanges a code for an access token', async () => {
    nock('https://discord.com')
      .post('/api/oauth2/token')
      .reply(200, {
        access_token: 'at',
        token_type: 'Bearer',
        expires_in: 600,
        scope: 'identify',
      });
    await expect(exchangeDashboardCode('code', 'v'.repeat(43))).resolves.toBe(
      'at',
    );
  });

  it('reads the signed-in user id and display name', async () => {
    nock('https://discord.com')
      .get('/api/v10/users/@me')
      .matchHeader('authorization', 'Bearer at')
      .reply(200, {
        id: '123456789012345678',
        username: 'handle',
        global_name: 'Shown',
      });
    await expect(fetchDiscordIdentity('at')).resolves.toEqual({
      id: '123456789012345678',
      username: 'Shown',
    });
  });

  it('falls back to the username and rejects a non-snowflake id', async () => {
    nock('https://discord.com')
      .get('/api/v10/users/@me')
      .reply(200, { id: '123456789012345678', username: 'handle' });
    await expect(fetchDiscordIdentity('at')).resolves.toEqual({
      id: '123456789012345678',
      username: 'handle',
    });
    nock('https://discord.com')
      .get('/api/v10/users/@me')
      .reply(200, { id: '../x', username: 'h' });
    await expect(fetchDiscordIdentity('at')).rejects.toThrow();
  });

  it('fails on a non-2xx identity response without echoing the body', async () => {
    nock('https://discord.com')
      .get('/api/v10/users/@me')
      .reply(401, 'secret-ish body');
    await expect(fetchDiscordIdentity('at')).rejects.toThrow(
      /^Discord identity lookup failed: 401$/,
    );
  });
});
```

Before Step 3, confirm arctic's Discord token endpoint path in `node_modules/arctic/dist/providers/discord.js` and match the nock (expected `https://discord.com/api/oauth2/token`).

```ts
// tst/web/pages.test.ts
import { describe, expect, it } from 'vitest';

import { errorPage, homePage, loginPage } from '../../src/web/pages.js';

describe('dashboard pages', () => {
  it('escapes and isolates the signed-in username', () => {
    const page = homePage({ username: '<img src=x>', csrfToken: 't' }, 'n');
    expect(page).toContain('<bdi>&lt;img src=x&gt;</bdi>');
    expect(page).not.toContain('<img src=x>');
  });

  it('puts the CSRF token in the logout form', () => {
    const page = homePage({ username: 'A', csrfToken: 'tok"en' }, 'n');
    expect(page).toContain('action="/dashboard/logout"');
    expect(page).toContain('name="_csrf" value="tok&quot;en"');
  });

  it('applies the nonce to the inline style and marks the page noindex', () => {
    const page = loginPage('abc');
    expect(page).toContain('<style nonce="abc">');
    expect(page).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(page).toContain('href="/dashboard/auth/start"');
  });

  it('shows a generic message per status and nothing else', () => {
    expect(errorPage(500, 'n')).toContain('Something went wrong');
    expect(errorPage(403, 'n')).toContain(
      'only for Moderators and the 1.5 Leadership Team',
    );
    expect(errorPage(503, 'n')).toContain('try again in a minute');
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/web/discordOAuth.ts
import { Discord } from 'arctic';

import Configuration from '../configuration.js';
import { BASE_DISCORD_BOT_URL } from '../constants.js';
import { boundedFetch } from '../util/boundedFetch.js';

const IDENTITY_TIMEOUT_MS = 10_000;
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Registered in the Discord developer portal by Hai. Not routed through
 * debugRedirect: local testing registers its own localhost URI instead, so
 * the session cookie is set on the host that will read it.
 */
export const dashboardRedirectUri = () =>
  `${BASE_DISCORD_BOT_URL}/dashboard/auth/callback`;

const provider = () =>
  new Discord(
    Configuration.discord.oauthClientId,
    Configuration.discord.oauthSecret,
    dashboardRedirectUri(),
  );

export function buildDashboardLoginUrl(
  state: string,
  codeVerifier: string,
): string {
  return provider()
    .createAuthorizationURL(state, codeVerifier, ['identify'])
    .toString();
}

/** The access token is used once, for /users/@me, and never stored. */
export async function exchangeDashboardCode(
  code: string,
  codeVerifier: string,
): Promise<string> {
  const tokens = await provider().validateAuthorizationCode(code, codeVerifier);
  return tokens.accessToken();
}

export async function fetchDiscordIdentity(
  accessToken: string,
): Promise<{ id: string; username: string }> {
  const response = await boundedFetch(
    'https://discord.com/api/v10/users/@me',
    { headers: { Authorization: `Bearer ${accessToken}` } },
    IDENTITY_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`Discord identity lookup failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    global_name?: unknown;
    id?: unknown;
    username?: unknown;
  };
  if (typeof body.id !== 'string' || !SNOWFLAKE.test(body.id)) {
    throw new Error('Discord identity lookup returned no usable id');
  }
  const shown =
    typeof body.global_name === 'string' && body.global_name
      ? body.global_name
      : typeof body.username === 'string'
        ? body.username
        : body.id;
  return { id: body.id, username: shown };
}
```

```ts
// src/web/pages.ts
import { SafeHtml, html, memberText } from './html.js';

export interface PageUser {
  username: string;
  csrfToken: string;
}

const STYLE = `
body{font-family:system-ui,sans-serif;margin:0;color:#1f2328;background:#f6f8fa}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 24px;background:#5865F2;color:#fff}
header form{margin:0}
main{max-width:960px;margin:24px auto;padding:0 16px}
button,.button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid #d0d7de;background:#fff;color:#1f2328;cursor:pointer;text-decoration:none}
.card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:16px;margin-bottom:16px}
`;

export function layout({
  title,
  nonce,
  user,
  body,
}: {
  title: string;
  nonce: string;
  user?: PageUser;
  body: SafeHtml;
}): string {
  const account = user
    ? html`<span>Signed in as ${memberText(user.username)}</span>
        <form method="post" action="/dashboard/logout">
          <input type="hidden" name="_csrf" value="${user.csrfToken}">
          <button type="submit">Sign out</button>
        </form>`
    : '';
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · 1.5 Gen Asians staff</title>
<style nonce="${nonce}">${new SafeHtml(STYLE)}</style>
</head>
<body>
<header><strong>1.5 Gen Asians staff dashboard</strong>${account}</header>
<main>${body}</main>
</body>
</html>`.value;
}

export function homePage(user: PageUser, nonce: string): string {
  return layout({
    title: 'Home',
    nonce,
    user,
    body: html`<div class="card">
      <h1>Welcome</h1>
      <p>Reports will appear here once the monthly build job is running.</p>
    </div>`,
  });
}

export function loginPage(nonce: string, notice?: string): string {
  return layout({
    title: 'Sign in',
    nonce,
    body: html`<div class="card">
      <h1>Staff sign-in</h1>
      <p>For Moderators and the 1.5 Leadership Team.</p>
      ${notice ? html`<p>${notice}</p>` : ''}
      <a class="button" href="/dashboard/auth/start">Sign in with Discord</a>
    </div>`,
  });
}

const ERROR_MESSAGES = {
  400: 'This sign-in link expired or was already used. Please sign in again.',
  403: 'This dashboard is only for Moderators and the 1.5 Leadership Team.',
  404: 'There is nothing at this address.',
  429: 'Too many requests. Please wait a minute and try again.',
  500: 'Something went wrong on our end. Please try again.',
  502: 'Discord did not complete the sign-in. Please try again.',
  503: 'The dashboard cannot check your access right now. Please try again in a minute.',
} as const;

export function errorPage(
  status: keyof typeof ERROR_MESSAGES,
  nonce: string,
): string {
  return layout({
    title: 'Error',
    nonce,
    body: html`<div class="card">
      <h1>${status === 500 ? 'Something went wrong' : 'Unable to continue'}</h1>
      <p>${ERROR_MESSAGES[status]}</p>
      <p><a href="/dashboard">Back to the dashboard</a></p>
    </div>`,
  });
}
```

- [ ] **Step 4: Run** `yarn test tst/web/discordOAuth.test.ts tst/web/pages.test.ts` → PASS.

- [ ] **Step 5: Commit** — `"Add dashboard Discord OAuth helpers and page shell"`.

### Task 1.7: Router — headers, login start, callback

**Files:**
- Create: `src/web/dashboardRouter.ts`
- Test: `tst/web/dashboardRouter.auth.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1.2–1.6.
- Produces:

```ts
export interface DashboardOAuth {
  buildLoginUrl(state: string, codeVerifier: string): string;
  exchangeCode(code: string, codeVerifier: string): Promise<string>;
  fetchIdentity(accessToken: string): Promise<{ id: string; username: string }>;
}
export interface DashboardDeps {
  cache: () => Promise<KeyValueCache>;
  checkAccess: AccessCheck;
  oauth: DashboardOAuth;
  sessionSecret: string;
  /** e.g. https://meetup-discord-bot.herokuapp.com — the only Origin a POST may carry. */
  origin: string;
  audit: (entry: LogEntry) => Promise<unknown>;
  now?: () => number;
  loginLimiter?: FixedWindowLimiter; // default 10 per minute per IP
  actionLimiter?: FixedWindowLimiter; // default 30 per minute per user
  /**
   * Later PRs add their pages here. Whatever this registers is mounted
   * AFTER the session gate and AFTER the unsafe-method guard (CSRF, Origin,
   * Sec-Fetch-Site, per-user rate limit), so a route cannot be added
   * without them.
   */
  protectedRoutes?: (router: express.Router) => void;
}
export function createDashboardRouter(deps: DashboardDeps): express.Router;
export const OAUTH_COOKIE = 'dash_oauth';
export const PUBLIC_ROUTE_PATHS: readonly string[]; // ['/login', '/auth/start', '/auth/callback']
/** Every route behind the gate, derived from the router stack (PR 3's access matrix uses this). */
export function protectedRouteList(router: express.Router): { method: string; path: string }[];
```

Test harness used by Tasks 1.7 and 1.8 (put at the top of each test file):

```ts
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DashboardDeps,
  PUBLIC_ROUTE_PATHS,
  createDashboardRouter,
  protectedRouteList,
} from '../../src/web/dashboardRouter.js';
import { FakeCache } from './fakeCache.js';

const SECRET = 's'.repeat(48);
const ORIGIN = 'https://meetup-discord-bot.herokuapp.com';
const USER = { id: '123456789012345678', username: 'Mod' };

function makeApp(overrides: Partial<DashboardDeps> = {}) {
  const cache = new FakeCache();
  const deps: DashboardDeps = {
    cache: async () => cache,
    checkAccess: vi.fn().mockResolvedValue(true),
    oauth: {
      buildLoginUrl: vi.fn(
        (state: string) => `https://discord.com/oauth2/authorize?state=${state}`,
      ),
      exchangeCode: vi.fn().mockResolvedValue('access'),
      fetchIdentity: vi.fn().mockResolvedValue(USER),
    },
    sessionSecret: SECRET,
    origin: ORIGIN,
    audit: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  const app = express();
  app.use('/dashboard', createDashboardRouter(deps));
  return { app, cache, deps };
}

/** Walks start → callback and returns the session cookie pair. */
async function signIn(app: express.Express): Promise<string> {
  const start = await request(app).get('/dashboard/auth/start');
  const state = new URL(start.headers.location).searchParams.get('state');
  const oauthCookie = (start.headers['set-cookie'] as unknown as string[])
    .find((c) => c.startsWith('dash_oauth='))
    .split(';')[0];
  const cb = await request(app)
    .get(`/dashboard/auth/callback?state=${state}&code=c`)
    .set('Cookie', oauthCookie);
  return (cb.headers['set-cookie'] as unknown as string[])
    .find((c) => c.startsWith('dash_sid='))
    .split(';')[0];
}
```

- [ ] **Step 1: Write the failing tests** (`tst/web/dashboardRouter.auth.test.ts`, harness above, then:)

```ts
describe('dashboard sign-in', () => {
  it('sends security headers and no-store on every response', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/dashboard/login');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toMatch(
      /default-src 'none'; style-src 'nonce-[A-Za-z0-9+/=]+'; script-src 'nonce-[A-Za-z0-9+/=]+'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'/,
    );
  });

  it('starts sign-in with a stored verifier and a state-binding cookie', async () => {
    const { app, cache, deps } = makeApp();
    const res = await request(app).get('/dashboard/auth/start');
    expect(res.status).toBe(302);
    const state = new URL(res.headers.location).searchParams.get('state');
    expect(state).toBeTruthy();
    expect(cache.ttls.get(`dashboard-oauth-${state}`)).toBe(600);
    expect(vi.mocked(deps.oauth.buildLoginUrl)).toHaveBeenCalledWith(
      state,
      cache.values.get(`dashboard-oauth-${state}`),
    );
    expect(res.headers['set-cookie'][0]).toBe(
      `dash_oauth=${state}; Path=/dashboard/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
  });

  it('signs an allowed member in and sends them home', async () => {
    const { app, deps } = makeApp();
    const sessionCookie = await signIn(app);
    expect(sessionCookie).toMatch(/^dash_sid=.+/);
    expect(deps.checkAccess).toHaveBeenCalledWith(USER.id);
    const home = await request(app).get('/dashboard').set('Cookie', sessionCookie);
    expect(home.status).toBe(200);
    expect(home.text).toContain('<bdi>Mod</bdi>');
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Dashboard sign-in' }),
    );
  });

  it('sets the session cookie with all attributes and a 12-hour Max-Age', async () => {
    const { app } = makeApp();
    const start = await request(app).get('/dashboard/auth/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/dashboard');
    const sid = (cb.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('dash_sid='),
    );
    expect(sid).toMatch(
      /; Path=\/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=43200$/,
    );
  });

  it('refuses a member without a dashboard role and creates no session', async () => {
    const { app, cache, deps } = makeApp({
      checkAccess: vi.fn().mockResolvedValue(false),
    });
    const start = await request(app).get('/dashboard/auth/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(cb.status).toBe(403);
    expect(cb.text).toContain('only for Moderators');
    expect([...cache.values.keys()].some((k) => k.startsWith('dashboard-session-'))).toBe(false);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Dashboard sign-in refused' }),
    );
  });

  it('rejects a callback whose state does not match the login cookie', async () => {
    const { app } = makeApp();
    const start = await request(app).get('/dashboard/auth/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', 'dash_oauth=someone-elses-state');
    expect(cb.status).toBe(400);
    const noCookie = await request(app).get(
      `/dashboard/auth/callback?state=${state}&code=c`,
    );
    expect(noCookie.status).toBe(400);
  });

  it('rejects a replayed state', async () => {
    const { app } = makeApp();
    const start = await request(app).get('/dashboard/auth/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const first = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(first.status).toBe(302);
    const replay = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(replay.status).toBe(400);
  });

  it('shows the login page again when the member cancels on Discord', async () => {
    const { app, deps } = makeApp();
    const start = await request(app).get('/dashboard/auth/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&error=access_denied`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(cb.status).toBe(400);
    expect(cb.text).toContain('Sign-in was cancelled');
    expect(deps.oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it('answers 502 with a generic page when the code exchange fails', async () => {
    const { app } = makeApp({
      oauth: {
        buildLoginUrl: (s: string) => `https://discord.com/x?state=${s}`,
        exchangeCode: vi.fn().mockRejectedValue(new Error('token body leak')),
        fetchIdentity: vi.fn(),
      },
    });
    const start = await request(app).get('/dashboard/auth/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(cb.status).toBe(502);
    expect(cb.text).not.toContain('token body leak');
  });

  it('answers 503 and creates no session when Discord cannot be asked about roles', async () => {
    const { app } = makeApp({
      checkAccess: vi.fn().mockRejectedValue(new Error('discord down')),
    });
    const start = await request(app).get('/dashboard/auth/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await request(app)
      .get(`/dashboard/auth/callback?state=${state}&code=c`)
      .set('Cookie', `dash_oauth=${state}`);
    expect(cb.status).toBe(503);
    expect(JSON.stringify(cb.headers['set-cookie'] ?? [])).not.toContain('dash_sid=');
  });

  it('sends HSTS', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/dashboard/login');
    expect(res.headers['strict-transport-security']).toBe(
      'max-age=15552000',
    );
  });

  it('sets no session cookie on a refused or failed callback', async () => {
    for (const overrides of [
      { checkAccess: vi.fn().mockResolvedValue(false) },
      {
        oauth: {
          buildLoginUrl: (s: string) => `https://discord.com/x?state=${s}`,
          exchangeCode: vi.fn().mockRejectedValue(new Error('x')),
          fetchIdentity: vi.fn(),
        },
      },
    ]) {
      const { app } = makeApp(overrides);
      const start = await request(app).get('/dashboard/auth/start');
      const state = new URL(start.headers.location).searchParams.get('state');
      const cb = await request(app)
        .get(`/dashboard/auth/callback?state=${state}&code=c`)
        .set('Cookie', `dash_oauth=${state}`);
      expect([403, 502]).toContain(cb.status);
      expect(JSON.stringify(cb.headers['set-cookie'] ?? [])).not.toContain(
        'dash_sid=',
      );
    }
  });

  it('does not wait for the sign-in audit post', async () => {
    const { app } = makeApp({
      audit: vi.fn(() => new Promise(() => undefined)),
    });
    await expect(signIn(app)).resolves.toMatch(/^dash_sid=/);
  });

  it('rate-limits the callback as well as the start', async () => {
    const { FixedWindowLimiter } = await import('../../src/web/rateLimit.js');
    const { app } = makeApp({ loginLimiter: new FixedWindowLimiter(1, 60_000) });
    await request(app).get('/dashboard/auth/callback?state=a&code=c');
    const second = await request(app).get(
      '/dashboard/auth/callback?state=a&code=c',
    );
    expect(second.status).toBe(429);
  });

  it('rate-limits sign-in per IP', async () => {
    const { FixedWindowLimiter } = await import('../../src/web/rateLimit.js');
    const { app } = makeApp({ loginLimiter: new FixedWindowLimiter(2, 60_000) });
    await request(app).get('/dashboard/auth/start');
    await request(app).get('/dashboard/auth/start');
    const third = await request(app).get('/dashboard/auth/start');
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();
  });
});
```

- [ ] **Step 2: Run** `yarn test tst/web/dashboardRouter.auth.test.ts` → FAIL.

- [ ] **Step 3: Implement** `src/web/dashboardRouter.ts` (this file is finished in Task 1.8; write it whole now and let 1.8's tests pin the session parts). Structure, by construction: public routes → `dashboardSessionGate` → one protected router whose first layer is `dashboardUnsafeMethodGuard` → error handler. Nothing else is ever mounted on the outer router.

```ts
import crypto from 'crypto';
import express, {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';
import { generateCodeVerifier, generateState } from 'arctic';
import { Logger } from 'tslog';

import { KeyValueCache } from '../lib/cache/base.js';
import { LogEntry } from '../lib/helpers/discordLogger.js';
import { clearCookie, parseCookies, serializeCookie } from './cookies.js';
import { errorPage, homePage, loginPage } from './pages.js';
import { FixedWindowLimiter } from './rateLimit.js';
import { AccessCheck } from './roleGate.js';
import {
  DashboardSession,
  ROLE_RECHECK_MS,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  SessionStore,
  safeEqual,
  signSessionId,
  verifySignedSessionId,
} from './session.js';

const logger = new Logger({ name: 'dashboard' });

export const OAUTH_COOKIE = 'dash_oauth';
export const PUBLIC_ROUTE_PATHS: readonly string[] = [
  '/login',
  '/auth/start',
  '/auth/callback',
];
const OAUTH_COOKIE_PATH = '/dashboard/auth';
const SESSION_COOKIE_PATH = '/dashboard';
const OAUTH_TTL_SEC = 10 * 60;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const oauthKey = (state: string) => `dashboard-oauth-${state}`;

export interface DashboardOAuth {
  buildLoginUrl(state: string, codeVerifier: string): string;
  exchangeCode(code: string, codeVerifier: string): Promise<string>;
  fetchIdentity(accessToken: string): Promise<{ id: string; username: string }>;
}

export interface DashboardDeps {
  cache: () => Promise<KeyValueCache>;
  checkAccess: AccessCheck;
  oauth: DashboardOAuth;
  sessionSecret: string;
  origin: string;
  audit: (entry: LogEntry) => Promise<unknown>;
  now?: () => number;
  loginLimiter?: FixedWindowLimiter;
  actionLimiter?: FixedWindowLimiter;
  protectedRoutes?: (router: express.Router) => void;
}

interface Locals {
  nonce: string;
  session?: DashboardSession;
  sid?: string;
}

const locals = (res: Response) => res.locals as Locals;

function send(res: Response, status: number, body: string) {
  res.status(status).type('html').send(body);
}

function fail(res: Response, status: Parameters<typeof errorPage>[0]) {
  if (!locals(res).nonce) {
    locals(res).nonce = crypto.randomBytes(16).toString('base64');
  }
  send(res, status, errorPage(status, locals(res).nonce));
}

const securityHeaders: RequestHandler = function securityHeaders(
  _req,
  res,
  next,
) {
  const nonce = crypto.randomBytes(16).toString('base64');
  locals(res).nonce = nonce;
  res.set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Content-Security-Policy':
      `default-src 'none'; style-src 'nonce-${nonce}'; ` +
      `script-src 'nonce-${nonce}'; img-src 'self'; form-action 'self'; ` +
      "frame-ancestors 'none'; base-uri 'none'",
    'Strict-Transport-Security': 'max-age=15552000',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  next();
};

function limit(
  limiter: FixedWindowLimiter,
  keyOf: (req: Request, res: Response) => string,
): RequestHandler {
  return (req, res, next) => {
    const key = keyOf(req, res);
    if (limiter.take(key)) {
      next();
      return;
    }
    res.set('Retry-After', String(limiter.retryAfterSec(key)));
    fail(res, 429);
  };
}

/** Express 5 layer shape, read only to list routes for tests and PR 3. */
interface StackLayer {
  name: string;
  route?: { path: string; methods: Record<string, boolean> };
  handle: { stack?: StackLayer[] };
}

export function protectedRouteList(
  router: express.Router,
): { method: string; path: string }[] {
  const outer = (router as unknown as { stack: StackLayer[] }).stack;
  const gate = outer.findIndex((l) => l.name === 'dashboardSessionGate');
  const inner = outer[gate + 1]?.handle.stack ?? [];
  return inner
    .filter((l) => l.route)
    .flatMap((l) =>
      Object.keys(l.route.methods)
        .filter((method) => l.route.methods[method])
        .map((method) => ({ method, path: l.route.path })),
    );
}

export function createDashboardRouter(deps: DashboardDeps): express.Router {
  const now = deps.now ?? Date.now;
  const loginLimiter = deps.loginLimiter ?? new FixedWindowLimiter(10, 60_000);
  const actionLimiter =
    deps.actionLimiter ?? new FixedWindowLimiter(30, 60_000);
  const sessions = async () => new SessionStore(await deps.cache(), now);
  const byIp = (req: Request) => req.ip ?? 'unknown';

  // Audit posts are fire-and-forget: a slow or failing Discord post must
  // never hold up or break a sign-in.
  const audit = (entry: LogEntry) => {
    Promise.resolve()
      .then(() => deps.audit(entry))
      .catch((error: unknown) =>
        logger.warn(`Dashboard audit post failed: ${String(error)}`),
      );
  };

  async function readSession(req: Request) {
    const signed = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    const sid = signed && verifySignedSessionId(signed, deps.sessionSecret);
    if (!sid) {
      return undefined;
    }
    const session = await (await sessions()).get(sid);
    return session ? { sid, session } : undefined;
  }

  const router = express.Router();
  router.use(securityHeaders);
  router.use(express.urlencoded({ extended: false, limit: '16kb' }));

  // ---- Public routes: the only ones reachable without a session. ----

  router.get('/login', (async (req, res) => {
    if (await readSession(req)) {
      res.redirect(302, '/dashboard');
      return;
    }
    send(res, 200, loginPage(locals(res).nonce));
  }) as RequestHandler);

  router.get('/auth/start', limit(loginLimiter, byIp), (async (_req, res) => {
    const state = generateState();
    const verifier = generateCodeVerifier();
    await (await deps.cache()).set(oauthKey(state), verifier, OAUTH_TTL_SEC);
    res.append(
      'Set-Cookie',
      serializeCookie(OAUTH_COOKIE, state, {
        path: OAUTH_COOKIE_PATH,
        maxAgeSec: OAUTH_TTL_SEC,
      }),
    );
    res.redirect(302, deps.oauth.buildLoginUrl(state, verifier));
  }) as RequestHandler);

  router.get('/auth/callback', limit(loginLimiter, byIp), (async (req, res) => {
    const state = String(req.query.state ?? '');
    const bound = parseCookies(req.headers.cookie).get(OAUTH_COOKIE) ?? '';
    res.append('Set-Cookie', clearCookie(OAUTH_COOKIE, OAUTH_COOKIE_PATH));
    // The cookie binds the callback to the browser that started sign-in, so
    // a callback URL lured into another browser cannot log that browser in.
    if (!state || !bound || !safeEqual(state, bound)) {
      fail(res, 400);
      return;
    }
    const cache = await deps.cache();
    const verifier = await cache.get(oauthKey(state));
    await cache.remove(oauthKey(state));
    if (!verifier) {
      fail(res, 400);
      return;
    }
    if (req.query.error || !req.query.code) {
      send(res, 400, loginPage(locals(res).nonce, 'Sign-in was cancelled.'));
      return;
    }
    let identity: { id: string; username: string };
    try {
      const accessToken = await deps.oauth.exchangeCode(
        String(req.query.code),
        verifier,
      );
      identity = await deps.oauth.fetchIdentity(accessToken);
    } catch (error: unknown) {
      logger.warn(`Dashboard sign-in exchange failed: ${String(error)}`);
      fail(res, 502);
      return;
    }
    let allowed: boolean;
    try {
      allowed = await deps.checkAccess(identity.id);
    } catch (error: unknown) {
      logger.warn(`Dashboard role check failed at sign-in: ${String(error)}`);
      fail(res, 503);
      return;
    }
    if (!allowed) {
      audit({
        title: 'Dashboard sign-in refused',
        description: `<@${identity.id}> tried to sign in without a dashboard role.`,
      });
      fail(res, 403);
      return;
    }
    const { sid } = await (await sessions()).create({
      userId: identity.id,
      username: identity.username,
    });
    res.append(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, signSessionId(sid, deps.sessionSecret), {
        path: SESSION_COOKIE_PATH,
        maxAgeSec: SESSION_TTL_SEC,
      }),
    );
    audit({
      title: 'Dashboard sign-in',
      description: `<@${identity.id}> signed in to the staff dashboard.`,
    });
    res.redirect(302, '/dashboard');
  }) as RequestHandler);

  // ---- The gate: a live session whose role check is current. ----

  const dashboardSessionGate = async function dashboardSessionGate(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const signedOut = () => {
      res.append('Set-Cookie', clearCookie(SESSION_COOKIE, SESSION_COOKIE_PATH));
      if (req.method === 'GET' || req.method === 'HEAD') {
        res.redirect(302, '/dashboard/login');
      } else {
        fail(res, 403);
      }
    };
    const found = await readSession(req);
    if (!found) {
      signedOut();
      return;
    }
    const { sid, session } = found;
    if (now() - session.roleCheckedAt >= ROLE_RECHECK_MS) {
      let allowed: boolean;
      try {
        allowed = await deps.checkAccess(session.userId);
      } catch (error: unknown) {
        // Fail closed, but keep the session: Discord being down is not the
        // member losing their role.
        logger.warn(`Dashboard role re-check failed: ${String(error)}`);
        fail(res, 503);
        return;
      }
      const store = await sessions();
      if (!allowed) {
        await store.destroy(sid);
        res.append(
          'Set-Cookie',
          clearCookie(SESSION_COOKIE, SESSION_COOKIE_PATH),
        );
        audit({
          title: 'Dashboard session ended',
          description: `<@${session.userId}> no longer holds a dashboard role.`,
        });
        fail(res, 403);
        return;
      }
      if (!(await store.markRoleChecked(sid, session))) {
        signedOut();
        return;
      }
    }
    locals(res).session = session;
    locals(res).sid = sid;
    next();
  };

  // ---- Everything behind the gate lives on this one router. ----

  const protectedRouter = express.Router();

  /**
   * Every method that can change state: per-user rate limit, then a
   * same-origin request (Origin, when sent, must be ours; Sec-Fetch-Site
   * must not be cross-site), then the session's CSRF token from the form
   * body or the X-CSRF-Token header. Each check stands alone: a matching
   * Origin never excuses a missing token.
   */
  protectedRouter.use(function dashboardUnsafeMethodGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const { session } = locals(res);
    if (!actionLimiter.take(session.userId)) {
      res.set('Retry-After', String(actionLimiter.retryAfterSec(session.userId)));
      fail(res, 429);
      return;
    }
    const origin = req.headers.origin;
    const body = req.body as Record<string, unknown> | undefined;
    const token =
      typeof body?._csrf === 'string' ? body._csrf : req.headers['x-csrf-token'];
    if (
      req.headers['sec-fetch-site'] === 'cross-site' ||
      (origin !== undefined && origin !== deps.origin) ||
      typeof token !== 'string' ||
      !safeEqual(token, session.csrfToken)
    ) {
      fail(res, 403);
      return;
    }
    next();
  });

  protectedRouter.get('/', (_req, res) => {
    const { session, nonce } = locals(res);
    send(res, 200, homePage(session, nonce));
  });

  protectedRouter.post('/logout', (async (_req, res) => {
    // Clear the cookie first, so the browser forgets it even if the store
    // call below fails.
    res.append('Set-Cookie', clearCookie(SESSION_COOKIE, SESSION_COOKIE_PATH));
    await (await sessions()).destroy(locals(res).sid);
    res.redirect(303, '/dashboard/login');
  }) as RequestHandler);

  deps.protectedRoutes?.(protectedRouter);

  protectedRouter.use((_req, res) => fail(res, 404));

  router.use(dashboardSessionGate as RequestHandler, protectedRouter);

  router.use(function dashboardErrorHandler(error, _req, res, _next) {
    logger.error(`Dashboard route error: ${String(error)}`);
    fail(res, 500);
  } as ErrorRequestHandler);

  return router;
}
```

Notes for the implementer:
- `res.append('Set-Cookie', …)` before `res.redirect` keeps both the cleared OAuth cookie and the session cookie. `req.ip` needs `app.set('trust proxy', 1)` on Heroku (Task 1.9).
- The stack-walk test in Task 1.8 depends on Express 5 layer internals (`layer.name`, `layer.route.path`, `layer.route.methods`, `layer.handle.stack`). Check them against `node_modules/router/lib/layer.js` before writing the test; if a name differs (e.g. the body parser's layer name), fix the test's expected names, never the structure. `express.urlencoded`'s layer name is expected to be `urlencodedParser`.
- `dashboardSessionGate` must stay a named function: the test finds it by name.

- [ ] **Step 4: Run** `yarn test tst/web/dashboardRouter.auth.test.ts` → PASS.

- [ ] **Step 5: Commit** — `"Add dashboard Discord sign-in routes"`.

### Task 1.8: Router — session gate, role re-check, CSRF, logout

**Files:**
- Test: `tst/web/dashboardRouter.session.test.ts` (harness from Task 1.7)
- Modify only if a test exposes a bug: `src/web/dashboardRouter.ts`

- [ ] **Step 1: Write the tests**

```ts
describe('dashboard session gate', () => {
  it('redirects a signed-out GET to the login page', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard/login');
  });

  it('refuses a signed-out POST with 403', async () => {
    const { app } = makeApp();
    expect((await request(app).post('/dashboard/logout')).status).toBe(403);
  });

  it('rejects a forged or tampered session cookie', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const tampered = `${cookie.slice(0, -2)}xx`;
    expect((await request(app).get('/dashboard').set('Cookie', tampered)).status).toBe(302);
    expect((await request(app).get('/dashboard').set('Cookie', 'dash_sid=abc.def')).status).toBe(302);
  });

  it('serves pages without re-checking the role inside 10 minutes', async () => {
    let now = 0;
    const checkAccess = vi.fn().mockResolvedValue(true);
    const { app } = makeApp({ checkAccess, now: () => now });
    const cookie = await signIn(app);
    now = 9 * 60 * 1000;
    expect((await request(app).get('/dashboard').set('Cookie', cookie)).status).toBe(200);
    expect(checkAccess).toHaveBeenCalledTimes(1);
  });

  it('re-checks the role after 10 minutes and destroys the session when it is gone', async () => {
    let now = 0;
    const checkAccess = vi.fn().mockResolvedValue(true);
    const { app, cache, deps } = makeApp({ checkAccess, now: () => now });
    const cookie = await signIn(app);
    now = 10 * 60 * 1000;
    checkAccess.mockResolvedValue(false);
    const res = await request(app).get('/dashboard').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect([...cache.values.keys()].some((k) => k.startsWith('dashboard-session-'))).toBe(false);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Dashboard session ended' }),
    );
    expect((await request(app).get('/dashboard').set('Cookie', cookie)).status).toBe(302);
  });

  it('keeps the session but answers 503 when Discord is unreachable at re-check', async () => {
    let now = 0;
    const checkAccess = vi.fn().mockResolvedValue(true);
    const { app } = makeApp({ checkAccess, now: () => now });
    const cookie = await signIn(app);
    now = 11 * 60 * 1000;
    checkAccess.mockRejectedValueOnce(new Error('down'));
    expect((await request(app).get('/dashboard').set('Cookie', cookie)).status).toBe(503);
    expect((await request(app).get('/dashboard').set('Cookie', cookie)).status).toBe(200);
  });

  it('expires the session 12 hours after sign-in', async () => {
    let now = 0;
    const { app } = makeApp({ now: () => now });
    const cookie = await signIn(app);
    now = 12 * 60 * 60 * 1000;
    expect((await request(app).get('/dashboard').set('Cookie', cookie)).status).toBe(302);
  });
});

describe('routes are gated by construction', () => {
  const ok = (_req: express.Request, res: express.Response) => {
    res.status(200).send('ok');
  };
  const withDummies = () =>
    makeApp({
      protectedRoutes: (r) => {
        r.get('/dummy', ok);
        r.post('/dummy', ok);
        r.put('/dummy', ok);
        r.delete('/dummy', ok);
      },
    });

  it('has no direct routes before the gate except the public ones', () => {
    const router = createDashboardRouter({
      ...makeApp().deps,
      protectedRoutes: (r) => {
        r.post('/dummy', ok);
      },
    });
    type Layer = {
      name: string;
      route?: { path: string };
      handle: { stack?: Layer[] };
    };
    const stack = (router as unknown as { stack: Layer[] }).stack;
    const gate = stack.findIndex((l) => l.name === 'dashboardSessionGate');
    expect(gate).toBeGreaterThan(-1);
    const beforeGate = stack.slice(0, gate);
    expect(
      beforeGate.filter((l) => l.route).map((l) => l.route.path).sort(),
    ).toEqual([...PUBLIC_ROUTE_PATHS].sort());
    expect(
      beforeGate.filter((l) => !l.route).map((l) => l.name),
    ).toEqual(['securityHeaders', 'urlencodedParser']);
    // The gate is followed directly by the protected router, and nothing
    // after it but the error handler.
    const after = stack.slice(gate + 1);
    expect(after.map((l) => l.name)).toEqual([
      'router',
      'dashboardErrorHandler',
    ]);
    // Inside the protected router the unsafe-method guard comes first.
    expect(after[0].handle.stack[0].name).toBe('dashboardUnsafeMethodGuard');
    expect(protectedRouteList(router)).toEqual(
      expect.arrayContaining([
        { method: 'get', path: '/' },
        { method: 'post', path: '/logout' },
        { method: 'post', path: '/dummy' },
      ]),
    );
  });

  it('refuses POST, PUT and DELETE on a hook route without a token', async () => {
    const { app } = withDummies();
    const cookie = await signIn(app);
    for (const method of ['post', 'put', 'delete'] as const) {
      const res = await request(app)[method]('/dashboard/dummy').set(
        'Cookie',
        cookie,
      );
      expect(res.status).toBe(403);
    }
    expect(
      (await request(app).get('/dashboard/dummy').set('Cookie', cookie)).status,
    ).toBe(200);
  });

  it('accepts a hook route with the token in the body or the header', async () => {
    const { app } = withDummies();
    const cookie = await signIn(app);
    const token = /name="_csrf" value="([^"]+)"/.exec(
      (await request(app).get('/dashboard').set('Cookie', cookie)).text,
    )[1];
    expect(
      (await request(app)
        .post('/dashboard/dummy')
        .set('Cookie', cookie)
        .type('form')
        .send({ _csrf: token })).status,
    ).toBe(200);
    expect(
      (await request(app)
        .delete('/dashboard/dummy')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', token)).status,
    ).toBe(200);
  });

  it('refuses a hook route when signed out', async () => {
    const { app } = withDummies();
    expect((await request(app).put('/dashboard/dummy')).status).toBe(403);
    expect((await request(app).get('/dashboard/dummy')).status).toBe(302);
  });
});

describe('dashboard CSRF and logout', () => {
  const csrfFrom = (page: string) =>
    /name="_csrf" value="([^"]+)"/.exec(page)[1];

  it('rejects a POST without the CSRF token', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const res = await request(app)
      .post('/dashboard/logout')
      .set('Cookie', cookie)
      .type('form')
      .send({});
    expect(res.status).toBe(403);
  });

  it('rejects a same-origin POST that has no token', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const res = await request(app)
      .post('/dashboard/logout')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({});
    expect(res.status).toBe(403);
  });

  it('rejects Origin: null and Sec-Fetch-Site: cross-site even with the token', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const token = csrfFrom(
      (await request(app).get('/dashboard').set('Cookie', cookie)).text,
    );
    expect(
      (await request(app)
        .post('/dashboard/logout')
        .set('Cookie', cookie)
        .set('Origin', 'null')
        .type('form')
        .send({ _csrf: token })).status,
    ).toBe(403);
    expect(
      (await request(app)
        .post('/dashboard/logout')
        .set('Cookie', cookie)
        .set('Sec-Fetch-Site', 'cross-site')
        .type('form')
        .send({ _csrf: token })).status,
    ).toBe(403);
  });

  it('rejects a POST with the wrong token or a foreign Origin', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const token = csrfFrom((await request(app).get('/dashboard').set('Cookie', cookie)).text);
    expect(
      (await request(app).post('/dashboard/logout').set('Cookie', cookie).type('form').send({ _csrf: 'nope' })).status,
    ).toBe(403);
    expect(
      (await request(app)
        .post('/dashboard/logout')
        .set('Cookie', cookie)
        .set('Origin', 'https://evil.example')
        .type('form')
        .send({ _csrf: token })).status,
    ).toBe(403);
  });

  it('logs out with a valid token and the session no longer works', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const token = csrfFrom((await request(app).get('/dashboard').set('Cookie', cookie)).text);
    const out = await request(app)
      .post('/dashboard/logout')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: token });
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe('/dashboard/login');
    expect((await request(app).get('/dashboard').set('Cookie', cookie)).status).toBe(302);
  });

  it('answers unknown dashboard paths with the generic 404 page when signed in', async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const res = await request(app).get('/dashboard/nope').set('Cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('renders the generic 500 page when a dependency throws', async () => {
    const { app } = makeApp({
      cache: async () => {
        throw new Error('redis gone: secret detail');
      },
    });
    const res = await request(app).get('/dashboard/auth/start');
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('secret detail');
  });
});
```

- [ ] **Step 2: Run** `yarn test tst/web/dashboardRouter.session.test.ts` → PASS (written against Task 1.7's implementation). Any failure is a bug in the router: fix the router, not the test.

- [ ] **Step 3: Mutation check** (each must turn at least one test red; revert after each):
  1. `>= ROLE_RECHECK_MS` → `> ROLE_RECHECK_MS * 100`
  2. Remove `await store.destroy(sid)` in the re-check denial branch.
  3. In `requireCsrf`, drop the `origin` clause.
  4. In the callback, delete `!safeEqual(state, bound) ||`.
  5. In `SessionStore.get`, delete the absolute-expiry check.
  6. In `hasDashboardRole`, add `SERVER_ROLES.organizer` to `DASHBOARD_ROLE_IDS`.
  6b. In `discordAccessCheck`, return `true` when `member.permissions.has(PermissionFlagsBits.Administrator)`.
  8. Remove `limit(loginLimiter, byIp)` from the callback route.
  9. In `dashboardUnsafeMethodGuard`, skip the token check when `origin === deps.origin`.
  10. Mount one route with `router.post(...)` directly on the outer router instead of the protected one.
  11. In `markRoleChecked`, drop the re-read.
  7. In `serializeCookie`, drop `'Secure'`.
  Record the result per mutation in the PR description.

- [ ] **Step 4: Commit** — `"Test the dashboard session gate, role re-check and CSRF"`.

### Task 1.9: Mount in the app

**Files:**
- Create: `src/web/dashboardDeps.ts`
- Modify: `src/app.ts` (before the 404 handler), `src/index.ts` (`clientReady`)
- Test: `tst/web/dashboardDeps.test.ts`

**Interfaces:**
- Produces: `setDashboardClient(client: Client | undefined): void`, `dashboardRouterFromEnv(env?: Record<string, string | undefined>): express.Router`, `MIN_SESSION_SECRET_LENGTH = 32`.

- [ ] **Step 1: Write the failing tests**

```ts
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { dashboardRouterFromEnv } from '../../src/web/dashboardDeps.js';

const appWith = (env: Record<string, string | undefined>) => {
  const app = express();
  app.use('/dashboard', dashboardRouterFromEnv(env));
  return app;
};

describe('dashboardRouterFromEnv', () => {
  it('serves a not-configured page when the session secret is missing', async () => {
    const res = await request(appWith({})).get('/dashboard/login');
    expect(res.status).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('not set up yet');
  });

  it('refuses a session secret shorter than 32 characters', async () => {
    const res = await request(appWith({ DASHBOARD_SESSION_SECRET: 'short' })).get(
      '/dashboard/login',
    );
    expect(res.status).toBe(503);
  });

  it('serves the login page when configured', async () => {
    const res = await request(
      appWith({ DASHBOARD_SESSION_SECRET: 'k'.repeat(48) }),
    ).get('/dashboard/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Sign in with Discord');
  });

});
```

Also extend `tst/integration/app.routes.test.ts` with:

```ts
it('mounts the dashboard ahead of the generic 404 page', async () => {
  const res = await request(app).get('/dashboard/login');
  expect([200, 503]).toContain(res.status);
  expect(res.headers['cache-control']).toBe('no-store');
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/web/dashboardDeps.ts
import crypto from 'crypto';
import { Client } from 'discord.js';
import express from 'express';

import { BASE_DISCORD_BOT_URL } from '../constants.js';
import { logActivity } from '../lib/helpers/discordLogger.js';
import { ApplicationCache } from '../util/cache.js';
import { createDashboardRouter } from './dashboardRouter.js';
import {
  buildDashboardLoginUrl,
  exchangeDashboardCode,
  fetchDiscordIdentity,
} from './discordOAuth.js';
import { html } from './html.js';
import { layout } from './pages.js';
import { discordAccessCheck } from './roleGate.js';

export const MIN_SESSION_SECRET_LENGTH = 32;

// Express boots before Discord logs in; index.ts hands the client over on
// ready, exactly as it does for the OAuth alert client.
let discordClient: Client | undefined;

export function setDashboardClient(client: Client | undefined) {
  discordClient = client;
}

function notConfiguredRouter(): express.Router {
  const router = express.Router();
  router.use((_req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res
      .status(503)
      .set({
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'`,
      })
      .type('html')
      .send(
        layout({
          title: 'Not available',
          nonce,
          body: html`<div class="card"><p>The staff dashboard is not set up yet.</p></div>`,
        }),
      );
  });
  return router;
}

export function dashboardRouterFromEnv(
  env: Record<string, string | undefined> = process.env,
): express.Router {
  const secret = env.DASHBOARD_SESSION_SECRET;
  if (!secret || secret.length < MIN_SESSION_SECRET_LENGTH) {
    return notConfiguredRouter();
  }
  return createDashboardRouter({
    cache: ApplicationCache,
    checkAccess: discordAccessCheck(() => discordClient),
    oauth: {
      buildLoginUrl: buildDashboardLoginUrl,
      exchangeCode: exchangeDashboardCode,
      fetchIdentity: fetchDiscordIdentity,
    },
    sessionSecret: secret,
    origin: new URL(BASE_DISCORD_BOT_URL).origin,
    audit: async (entry) =>
      discordClient ? logActivity(discordClient, entry) : false,
  });
}
```

`src/app.ts` — after `const app = express();` add `app.set('trust proxy', 1); // Heroku's router: req.ip is the client, for the dashboard rate limits`; and immediately before the `// Any stale or mistyped bot URL` 404 block:

```ts
app.use('/dashboard', dashboardRouterFromEnv());
```

with `import { dashboardRouterFromEnv } from './web/dashboardDeps.js';`.

`src/index.ts` — in `clientReady`, next to `setOAuthAlertClient(client);`: `setDashboardClient(client);` with the import.

- [ ] **Step 4: Run** `yarn test` → all pass. `yarn lint` → clean. `yarn tsc --noEmit -p .` → no errors.

- [ ] **Step 5: Commit** — `"Mount the staff dashboard in the bot's Express app"`.

### Task 1.10: Verify and open the draft PR

- [ ] **Step 1:** `yarn lint && yarn test` → green. Integration: throwaway `postgres:16` on `127.0.0.1:55432` and `redis:7` on `127.0.0.1:56379`, then `DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres REDISCLOUD_URL=redis://127.0.0.1:56379 yarn test:integration` → green; stop both containers (and colima if started here).
- [ ] **Step 2: Local smoke without real Discord.** Do not use `yarn start` (it logs the bot in with real credentials). Run a scratch script in the session scratchpad that mounts `createDashboardRouter` with fake deps on port 5055, then load `/dashboard/login`, `/dashboard/auth/start`, the fake callback and `/dashboard` in the built-in browser; screenshot login and home pages for the PR.
- [ ] **Step 3:** Push `feat/dashboard-1-auth`, open a **draft** PR against `main`. Description: summary; Hai's checklist (redirect URI, `DASHBOARD_SESSION_SECRET`); env vars added (names only); security notes (cookies, CSRF, CSP, rate limits, in-process limiter assumes one web dyno); mutation-check table; deploy-window note; footer line.
- [ ] **Step 4:** Report to the lead and wait for merge confirmation before PR 2.

---

# PR 1b — Close the `/redirect` open redirect (GitHub #109)

Branch `fix/redirect-allow-list`. Right after PR 1 merges, before anyone is sent to the staff login. Small; full code written at the start. The PR references #109.

`/redirect/:url` in `src/app.ts` 307s to any base64-encoded URL, on the same origin as the staff login. It cannot simply be removed or limited to localhost: production's own Meetup connect flow passes through it (production logs show `Redirecting to https://meetup-discord-bot.herokuapp.com/connect/meetup/callback`), because `debugRedirect` in `src/constants.ts` always builds the trampoline URL and Meetup does not accept localhost redirect URIs.

**Allowed targets**, parsed with `URL` and compared exactly:
- The app's own origin, derived from the configured base, not a hard-coded string: `new URL(debugRedirect('/')).origin`, or a new `PUBLIC_APP_ORIGIN` constant that both `debugRedirect` and the check use.
- `http://localhost:<port>` and `http://127.0.0.1:<port>` (`http:` only, exact hostname).

Everything else gets 400 with the branded error page: other hosts, look-alikes (`meetup-discord-bot.herokuapp.com.evil.example`, `localhost.evil.example`), userinfo (`https://x@evil.example`), other schemes (`javascript:`, `data:`, `https://localhost`). Malformed base64 or URLs also get 400 instead of throwing.

| # | Task | Tests (file → names) | Acceptance |
|---|---|---|---|
| 1b.1 | Allow-list in the `/redirect/:url` handler, with the allowed origin shared with `debugRedirect` | `tst/integration/app.routes.test.ts` → `still redirects the production Meetup callback through the trampoline (query appended)`, `redirects to a localhost target with the query appended`, `redirects to a 127.0.0.1 target`, `refuses an external host`, `refuses look-alike hosts`, `refuses userinfo`, `refuses javascript:, data: and https://localhost`, `answers 400 to malformed base64 or URL` | Production Meetup connect flow unchanged; local dev trampoline still works |

---

# PR 2a — Organizer token: cross-process critical section

Branch `feat/organizer-token-lock`. After PR 1b merges, before PR 2. Its own PR because it touches the production credential that identity monitoring depends on. Full code written at the start.

**Problem.** The in-process mutex is not enough. The web dyno's 18:00 sweep, the build job, manual refresh and the backfill one-off dyno can each refresh the same rotating refresh token. The loser sends an already-rotated token, gets `invalid_grant`, and identity monitoring dies.

**Design.**

- New `src/lib/helpers/organizerMeetupClient.ts` exposes `getOrganizerAccessToken({ forceRefresh?: boolean }): Promise<string | undefined>` and `organizerMeetupClient(): Promise<GqlMeetupClient | undefined>`.
- Refresh is a Postgres critical section on the credential repository's single connection, run by a new `PostgresCredentialRepository.withLockedCredential(key, fn)`:

```sql
BEGIN;
SELECT pg_advisory_xact_lock(7595882001);   -- constant: organizer credential
SELECT access_token, refresh_token, expires_at FROM oauth_credentials WHERE key = $1;
-- if expires_at > now() + 5 min and not forceRefresh: COMMIT, return access_token
-- else refreshMeetupToken(stored refresh, then config seed); UPDATE/INSERT the row
COMMIT;
```

  All reads and writes happen on the transaction's client (the pool is `max: 1`; a nested pool query would deadlock).
- A persist failure keeps the existing rule: use the fresh token for this run, log loudly, and never fall through to the seed.
- In-process de-dup sits on top: concurrent callers in one process share one in-flight promise.
- Callers fetch a token per batch, not once per run. On a 401 from a reused token they call `getOrganizerAccessToken({ forceRefresh: true })` once and retry.
- `meetupSweep.ts` switches to this helper. Its behaviour changes on purpose (token reuse, cross-process lock); the existing sweep tests must still pass.

| # | Task | Tests (file → names) | Acceptance |
|---|---|---|---|
| 2a.1 | `withLockedCredential` on the credential repository | `tst/integration/postgresCredentialRepository.test.ts` → `serializes two independent repository instances racing to refresh` (two pools against the same throwaway Postgres; refresh nock counts exactly one call; both callers get the same access token), `rolls back on a thrown refresh` | Throwaway pg :55432 |
| 2a.2 | `organizerMeetupClient.ts` | `tst/lib/helpers/organizerMeetupClient.test.ts` → `reuses an access token with more than 5 minutes left`, `refreshes inside 5 minutes of expiry`, `forceRefresh refreshes even when valid`, `concurrent in-process callers share one refresh`, `falls back to the config seed only when the stored refresh fails`, `persist failure keeps the fresh token for this run`, `returns undefined without DATABASE_URL` | Mutation-check the 5-minute boundary and the seed fallback |
| 2a.3 | Switch the sweep; 401 retry | `meetupSweep` tests → `retries once with a forced refresh on 401`, existing tests green | |
| 2a.4 | Read-only visibility check (needs Hai's go-ahead to use the real organizer credential) | — | The slash commands use the invoking mod's token today. Before PR 2 relies on the organizer token, confirm it can see `NO_SHOW` and `ATTENDED` RSVPs: one read-only `getEventRsvps` on a past event, counts only, no names printed. Hai runs it or explicitly approves running it. |

## Renew organizer login (added 2026-10-15, Hai via the lead)

**Why.** When the shared organizer credential dies (refresh fails with `invalid_grant`, or the locked path cannot produce a usable token), any dashboard user (Moderator or 1.5 Leadership Team) restores it from the dashboard. Today that takes `/meetup_get_token sweep_credential:True` plus a Heroku config change. Meetup returns no refresh-token lifetime, so there is no advance warning; the failure itself is the trigger.

**How a staff member uses it.** The alert links to the page. They open the dashboard in a private/incognito window, sign in with Discord, open **Renew organizer login**, press the button, and sign in to Meetup as the shared organizer account. The bot verifies the account and stores the credential.

**Design.**

- **Routes**, registered via `protectedRoutes`, so they sit behind the gate and the unsafe-method guard:
  - `GET /dashboard/organizer-login`: the page. It shows the credential status (healthy / failing since …) and the start button.
  - `POST /dashboard/organizer-login/start` (CSRF).
  - `GET /dashboard/organizer-login/complete`.
- **OAuth state** is its own one-time value in Redis (`organizer-renew-<state>`, 10 min TTL). Its record holds `{ purpose: 'organizer-renew', sessionHash: sha256(sid), discordUserId }`.
- **The callback.** Meetup's only registered redirect is still `/connect/meetup/callback`, through the trampoline, so it works under the #109 allow-list unchanged.
  - The existing callback handler sees `purpose: 'organizer-renew'` and 302s to `/dashboard/organizer-login/complete?state=…&code=…`, a fixed same-origin path; the state stays unconsumed.
  - That hop is needed because the dashboard session cookie (`Path=/dashboard`) is not sent to `/connect/...`.
  - The member-link flow is untouched for every other state.
- **`/complete`**, behind the gate:
  - Requires the state's `sessionHash` to equal the current session's, and consumes the state (one-time).
  - Exchanges the code, reads `self { id }` with the new access token, then applies the safeguard (below).
  - Saves through the same advisory-locked repository write that refresh uses (`withLockedCredential`), so a renewal and a refresh are serialized.
- **Safeguard.** No personal account may become the sweep credential.
  - `oauth_credentials` gains `member_id TEXT` (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`).
  - It is recorded on every successful store or refresh: one `self { id }` query when the column is null.
  - At renewal the authorizing account's id must equal the recorded one. If it differs: "This Meetup account is not the shared organizer account. Nothing was saved." Nothing is stored and nothing is consumed except the state.
- **Bootstrap** (no id recorded yet). The expected id falls back to a new non-secret config value, `MEETUP_ORGANIZER_MEMBER_ID`, the shared account's Meetup member id, which Hai sets once.
  - If neither the recorded id nor the config value exists, the renewal is refused, with a message saying to set it.
  - Chosen over a role check: Meetup's `LEADER` status also covers Event Organizers, who log in with personal accounts, so a role check would let exactly the wrong account through. An explicit id is unambiguous.
- **Alert, reusing the sweep's existing one.** "Meetup identity monitoring is not running" already fires on credential failure.
  - It becomes episode-based: `oauth_credentials.failing_since TIMESTAMPTZ` is set (inside the lock) on the first failure, and the alert posts only when it changes from null.
  - The description gains a link to `/dashboard/organizer-login`.
  - On the next success `failing_since` is cleared and one recovery post goes out: "Meetup organizer login restored".
  - The failure state is durable in Postgres, so restarts don't re-post.
- **Logging.** Every renewal attempt goes to the staff moderation channel, accepted or refused, naming the actor as `<@id>` and the reason (wrong account / bootstrap missing / success). It never includes tokens or the Meetup account's details beyond "matches" / "does not match".
- **Unchanged:** `/meetup_get_token sweep_credential:True` keeps working. The config seed `MEETUP_ORGANIZER_REFRESH_TOKEN` stays as a recovery path.

| # | Task | Tests (file → names) | Acceptance |
|---|---|---|---|
| 2a.5 | Credential schema: `member_id`, `failing_since`; record the id on store/refresh | `tst/integration/postgresCredentialRepository.test.ts` → `adds the columns idempotently`, `records the member id on the first successful refresh`, `marks and clears failing_since inside the lock` | |
| 2a.6 | Episode-based alert with renew link + recovery post | `tst/lib/helpers/organizerMeetupClient.test.ts` → `alerts once per failure episode`, `does not re-alert across restarts while failing`, `posts one recovery message when it works again`, `alert links the renew page and never includes the error body` | Reuses the existing alert title |
| 2a.7 | Renew routes + callback branch | `tst/web/routes/organizerLogin.test.ts` → `signed out → 302 / wrong role → 403 on every route`, `start requires CSRF`, `complete refuses a state from another session`, `complete refuses a replayed state`, `stores the right account through the locked write`, `refuses the wrong account and stores nothing`, `bootstrap: uses MEETUP_ORGANIZER_MEMBER_ID when none is recorded`, `bootstrap: refuses when neither is set`, `logs each attempt to the moderation channel with <@id> and no token`; `tst/integration/app.routes.test.ts` → `the Meetup callback hands an organizer-renew state to the dashboard completion path`, `member-link states are unaffected`; integration → `a renewal concurrent with a refresh is serialized by the lock` | Works through the #109 trampoline allow-list |

---

# PR 2 — Snapshots and build job

Branch `feat/dashboard-2-snapshots`. Starts after PR 2a merges. Full-code addendum first.

## File structure

| File | Responsibility |
|---|---|
| `src/lib/reports/period.ts` | `Period` (`{ year, month }`), Pacific bounds, `previousPeriod`, `periodKey('2026-09')`, `parsePeriodKey`, `isFinished(period, now)` |
| `src/lib/reports/meetupMonth.ts` | `getEventsYearMonth` (moved from the command, re-exported there), `fetchMonthRsvps`: one pass per event for `ATTENDED`/`YES`/`NO_SHOW` |
| `src/lib/reports/hallOfFameReport.ts` | `buildHallOfFameReport` → JSON-safe payload; `formatHostingStatsText` (the command's attachment, byte-identical) |
| `src/lib/reports/noShowReport.ts` | `buildNoShowReport` → JSON-safe payload with `asOf`; `toNoShowCases` for the existing text/CSV formatters |
| `src/lib/repositories/dashboardPool.ts` | One shared `pg.Pool` (`max: 3` on the web dyno; `PG_POOL_MAX` overrides it for scripts) + idempotent `DASHBOARD_SCHEMA_SQL` |
| `src/lib/repositories/postgresReportSnapshotRepository.ts` | `report_snapshots` reads/writes |
| `src/lib/repositories/postgresLinkProgressRepository.ts` | `link_progress_daily` |
| `src/lib/reports/linkProgress.ts` | Pure counting from guild members + member links |
| `src/lib/reports/buildJob.ts` | Due-plan, lease, build, alerts, report-ready notice, scheduler, `requestRebuild` |
| `src/lib/helpers/discordLogger.ts` (modify) | Superseded in PR 4 (no pings): no role-notice helper. The report-ready notice is a plain `logAlert` embed with `allowedMentions: { parse: [] }`, and no log function sends `content`. |
| `src/lib/repositories/postgresSuspensionRepository.ts` (modify) | `listByMemberIds(ids: string[], before?: Date)`: one `member_id = ANY($1)` query |
| `src/commands/meetup/getEventStats.ts`, `noShowReport.ts` (modify) | Call the services; output unchanged |

## Connection budget

The web dyno already holds up to 13 connections (member 5, suspension 5, identity 2, credential 1). The dashboard pool adds at most 3 (16 of essential-0's 20). The backfill dyno uses one small pool (`PG_POOL_MAX=2`) and reads suspension history with one `ANY($1)` query per batch.

## Schema (`DASHBOARD_SCHEMA_SQL`)

```sql
CREATE TABLE IF NOT EXISTS report_snapshots (
  id              SERIAL PRIMARY KEY,
  report_type     TEXT NOT NULL CHECK (report_type IN ('hall_of_fame', 'no_show')),
  period          DATE NOT NULL CHECK (EXTRACT(DAY FROM period) = 1),
  built_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  built_by        TEXT NOT NULL,
  source_complete BOOLEAN NOT NULL,
  payload         JSONB NOT NULL,
  superseded_by   INTEGER REFERENCES report_snapshots(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS report_snapshots_current_idx
  ON report_snapshots (report_type, period) WHERE superseded_by IS NULL;
CREATE TABLE IF NOT EXISTS link_progress_daily (
  day             DATE PRIMARY KEY,
  linked          INTEGER NOT NULL,
  unlinked        INTEGER NOT NULL,
  reverify_tagged INTEGER NOT NULL,
  onboarding      INTEGER NOT NULL
);
-- Not in the spec: durable "report ready already posted" marker, so a
-- restart can't post the notice twice and a failed post is retried.
CREATE TABLE IF NOT EXISTS dashboard_notices (
  kind      TEXT NOT NULL,
  period    DATE NOT NULL,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, period)
);
```

**Bounded growth.** While a month is open (the current month), its snapshot row is updated in place (`UPDATE … SET payload, built_at, built_by, source_complete WHERE id = current`), so daily builds don't pile up. Once the month is finished, a rebuild inserts a new row and supersedes the old one, keeping the history someone may have acted on: `pg_advisory_xact_lock(hashtext(type || period))`; `newId = nextval(…)`; `UPDATE … SET superseded_by = newId WHERE … superseded_by IS NULL`; `INSERT … (id, …) VALUES (newId, …)`.

## Payload rules

- **No descriptions in Postgres.** Snapshots carry no upcoming RSVPs at all (see the next rule). Counted no-show events keep `id, title, eventUrl, dateTime` only.
- **`asOf`.**
  - **Finished months, every build** (job, backfill, manual refresh): `asOf` = the first instant of the following month in Pacific time. No-shows count only up to `asOf`; suspension history is filtered to `suspendedAt < asOf` (one `listByMemberIds(ids, asOf)` query). So refreshing September after a suspension recorded on Oct 3 still shows that member as a September candidate.
  - **The current month:** `asOf = now`.
  - `asOf` is stored in the payload and shown on pages.
  - The slash commands keep using `now` and keep their output.
- **Upcoming RSVPs, act-by dates and 💵 marks are live**, computed at render time (PR 4) with the organizer client and cached in Redis for at most 12 h. They are never frozen in a snapshot.
- **Every case carries `priorSuspensions`** (as of `asOf`; the warning template needs the next penalty) and `hostedPastEvent` (`getGroupEventsCount({ hostId, status: ['PAST'], beforeDateTime: asOf }) > 0`).
- **`source_complete`** is false when the month has events and none of their RSVPs is `ATTENDED` or `NO_SHOW` (attendance never taken).
- **Summary.** The payload carries a small `summary` object (`events`, `hosts`, `newHosts`, `warnings`, `suspensionCandidates`, `noShows`), so trends read `payload->'summary'` without loading whole payloads.

## Build job rules

- **Never during the identity sweep.** Two guards, both required:
  - Clock: no build starts 18:00–19:00 UTC.
  - Claim: the build job and `requestRebuild` defer while today's `identity-digest-<date>` claim is held without its `identity-digest-done-<date>` marker.
  - Manual refresh is also refused 18:00–19:00 UTC with "try again after 19:00 UTC".
- **Postgres is the durable fact; Redis is only the lease.**
  - A month is built when its current snapshot exists with `built_at` past the due time.
  - Lease `report-build-claim` holds a random value and is released only if it still holds that value (the `withLock` pattern).
  - The TTL starts at 30 min. Measure a fixture build and a real one (log the duration), and record both in the PR.
- **Schedule** (15-minute ticks):
  - The previous month is rebuilt daily from the 2nd through the 7th, after 16:00 UTC, because attendance is often marked late.
  - The current month is rebuilt once per UTC day after 16:00 UTC.
  - `link_progress_daily` is written once per day.
- **Alerts** (#meetup-bot-alerts): one per failing month per day, plus a recovery alert. They include the duration and a safe error summary (the digest's `safeErrorSummary` rule).
- **Report ready.**
  - Posted to **#meetup-bot-alerts** (`BOT_ALERTS_CHANNEL_ID`, `1537755631602237473`, chosen by Hai 2026-10-15), so there is no new channel constant.
  - Superseded in PR 4 (no pings): a plain alert embed, no `content`, `allowedMentions: { parse: [] }`. It links the month's workspace, Hall of Fame and no-show history.
  - Posted for the **latest finished month** when no `dashboard_notices` row exists, even if the backfill built that month first. The backfill itself never posts it.
  - Superseded in PR 4: the `dashboard_notices` row records a claim time and a post time. The month's workspace is synced before posting. An unposted claim older than 30 minutes, or a failed post, is retried after first checking the channel for the notice, so delivery is at least once.

## Tasks

| # | Task | Tests (file → names) | Acceptance |
|---|---|---|---|
| 2.1 | Golden tests of current command output, before touching it | `tst/commands/meetup/getEventStats.golden.test.ts`, `tst/commands/meetup/noShowReport.golden.test.ts`. Mock at the **GraphQL HTTP layer** (nock on `https://api.meetup.com/gql-ext` with a responder that honours the query's filter variables: status, dates, `rsvpStatus`, `hostId`, pagination), not `GqlMeetupClient` methods. Fixtures (synthetic names) in `tst/fixtures/meetup/`: zero no-shows (early-exit message), cleared members, a departed member, a DST month (March/November), multi-page RSVPs, new vs returning hosts. Golden the attachment text, the CSV and the Discord message text. | Goldens committed and green on unmodified code |
| 2.2 | `period.ts` | `tst/lib/reports/period.test.ts` → `bounds are Pacific midnights across DST`, `previousPeriod wraps January`, `parsePeriodKey rejects 2026-13, 2026-1, 26-01, ../`, `isFinished flips at Pacific month start` | |
| 2.3 | `meetupMonth.ts` + `noShowReport.ts` + `hallOfFameReport.ts`; commands switched over | `tst/lib/reports/noShowReport.test.ts` → `classifies a finished month as of its end, ignoring later suspensions`, `refreshing a finished month after a new suspension still lists the member`, `counts no-shows only up to asOf`, `stores no upcoming RSVPs or descriptions`, `marks a month without attendance incomplete`, `adds prior suspensions to warnings`, `flags members who hosted a past event`; `tst/lib/reports/hallOfFameReport.test.ts` → `counts attendance from one RSVP pass`, `payload is JSON round-trippable` | 2.1 goldens still green (proof of no drift) |
| 2.4 | `dashboardPool.ts` + snapshot repository | `tst/integration/postgresReportSnapshotRepository.test.ts` → `save then getCurrent`, `current month updates in place`, `finished-month rebuild supersedes and keeps history`, `concurrent saves leave exactly one current row`, `schema is idempotent`, `listSummaries pages without payloads`, `PG_POOL_MAX overrides the pool size` | Throwaway pg :55432 |
| 2.5 | Link progress (pure + repository) | `tst/lib/reports/linkProgress.test.ts` → `counts linked only among current non-bot members`, `excludes onboarding from unlinked`, `counts Reverify-tagged`; `tst/integration/postgresLinkProgressRepository.test.ts` → `upsert is idempotent per day` | |
| 2.6 | Build job | `tst/lib/reports/buildJob.test.ts` → `never starts 18:00–19:00 UTC`, `defers while the identity digest claim is held without its done marker`, `previous month rebuilt daily from the 2nd to the 7th after 16:00 UTC`, `current month due once per UTC day after 16:00`, `link progress due once per day`, `a missing Redis done-key does not rebuild a month Postgres shows as built`, `lease release only removes its own claim`, `failure releases the claim and alerts once per day`, `recovery alert after failures`, `report-ready is a plain alert with allowedMentions { parse: [] }` (was a role-mention test; superseded in PR 4, no pings), `report-ready posts once per period across restarts`, `report-ready for the latest finished month even when the backfill built it`, `failed report-ready post is retried`, `requestRebuild refuses while a build runs`, `requestRebuild refused 18:00–19:00 UTC` | Mutation-check the due-plan, both guards and the lease |
| 2.7 | Wire the scheduler into `index.ts`; PR | `tst/lib/reports/buildJob.scheduler.test.ts` → `tick swallows and logs errors` | Draft PR. The bot already posts to #meetup-bot-alerts; no mention permission is needed (superseded in PR 4: no pings) |

---

# PR 3 — Read-only pages, trends, backfill

Branch `feat/dashboard-3-pages`. Starts after PR 2 merges. Full-code addendum first. Every page is registered through `protectedRoutes`, so the gate and the unsafe-method guard apply by construction.

## File structure

| File | Responsibility |
|---|---|
| `src/web/links.ts` | `meetupProfileUrl(id)` / `discordProfileUrl(id)` → `undefined` unless all digits (Meetup `^\d{1,20}$`, Discord `^\d{17,20}$`); `memberLink(...)`; every href passes `safeHref` |
| `src/web/paging.ts` | `parsePage(query)` (1-based, cap 10 000), page links, `PAGE_SIZE = 50` |
| `src/web/charts.ts` | Inline SVG line/bar charts drawn on the server. Presentation attributes only (`fill=`, `stroke=`), never `style=""`, which the nonce'd CSP blocks. No third-party JS. |
| `src/web/routes/home.ts`, `hallOfFame.ts`, `noShowHistory.ts`, `suspensions.ts`, `identity.ts`, `linkProgress.ts`, `trends.ts` | One file per page: data fetch + render; each exports a `register(router)` passed to `protectedRoutes` |
| `src/web/routes/refresh.ts` | `POST /dashboard/reports/:type/:period/refresh` → `requestRebuild` (guard handles CSRF and rate limit) |
| `src/lib/repositories/postgresSuspensionRepository.ts` (modify) | `listPage({ state: 'active' \| 'past' \| 'voided', offset, limit })` including void fields |
| `src/lib/repositories/postgresIdentityRepository.ts` (modify) | `listChangesPage({ since, until, platform, subjectId, beforeId, limit })` keyset; `getChangeThumb(id, side)` returning one `Buffer` |
| `scripts/backfillReports.ts` | Resumable all-time backfill |

Pages use form POSTs only (no `fetch`), so the CSP needs no `connect-src`. If a page ever uses `fetch`, add `connect-src 'self'`.

## Tasks

| # | Task | Tests (file → names) | Acceptance |
|---|---|---|---|
| 3.1 | Links and paging | `tst/web/links.test.ts` → `refuses non-digit ids`, `refuses 21-digit ids`, `event links pass safeHref or render as text`; `tst/web/paging.test.ts` → `clamps page`, `ignores junk` | |
| 3.2 | Access matrix derived from the router | `tst/web/routes/access.test.ts` iterates `protectedRouteList(router)` (never a hand list) → for each GET: `signed out → 302`, `role gone at re-check → 403`, `allowed → 200`; for each unsafe method: `no token → 403` | A new route without coverage is impossible: the list comes from the stack |
| 3.3 | Home | `home.test.ts` → `shows latest month counts`, `says "not built yet" with no snapshot`, `marks incomplete months` | |
| 3.4 | Hall of Fame page + copy-ready text + refresh | `hallOfFame.test.ts` → `escapes host names and event titles`, `copy text comes from a readonly textarea value`, `copy text matches the command's ready-to-post block`, `refresh refused while a build runs`, `refresh refused 18:00–19:00 UTC` | Copy button reads the `<textarea readonly>` value; never script-embedded text |
| 3.5 | No-show history (per month, per member) | `noShowHistory.test.ts` → `per-member view lists every month the member appears in`, `member id must be digits`, `paginates at 50`, `shows asOf` | Per-member lookup uses `payload->'cases' @> '[{"memberId":"…"}]'` with a GIN index on `payload jsonb_path_ops` |
| 3.6 | Suspension records | `suspensions.test.ts` + integration `listPage` tests → `active/past split matches /meetup_list_suspensions`, `shows void reason and who voided` | |
| 3.7 | Identity changes + thumbnails | `identity.test.ts` → `filters by date, platform, member`, `keyset paging is stable`, `thumb route serves only PNG/JPEG/WebP by magic bytes`, `thumb route 404s for a missing side`, `thumb response is no-store and nosniff` | Thumbs read one row per request (`SELECT old_thumb … WHERE id=$1`) |
| 3.8 | Link progress + trends | `charts.test.ts` → `escapes labels`, `uses no style attributes`, `handles a single point and all-zero series`; `trends.test.ts` → `reads summaries only` | |
| 3.9 | Backfill script | `tst/scripts/backfillReports.test.ts` → `refuses to start 18:00–19:00 UTC`, `skips months with a snapshot unless --force`, `posts progress every 12 months via REST`, `never logs in to the gateway or registers commands`, `stores no-attendance months as incomplete`, `uses asOf = month end`, `reads suspension history in one query per batch` | Discord via `@discordjs/rest` (`rest.post(Routes.channelMessages(BOT_ALERTS_CHANNEL_ID), { body: { embeds, allowed_mentions: { parse: [] } } })`), no `Client`. `PG_POOL_MAX=2`. Hai runs `heroku run:detached -a meetup-discord-bot "PG_POOL_MAX=2 yarn tsx scripts/backfillReports.ts"`, never 18:00–19:00 UTC |

---

# PR 4 — No-show workspace

Branch `feat/dashboard-4-workspace`. Starts after PR 3 merges. Full-code addendum first.

The PR 4 implementation followed a detailed task addendum; where this section and the code differ, the code and the spec win. The corrections that change what this section says are folded in below.

## Schema

The workspace schema references `suspension_records`, so `ensureWorkspaceSchema()` first awaits `PostgresSuspensionRepository.instance()`, which creates that table.

```sql
CREATE TABLE IF NOT EXISTS noshow_workspace_rows (
  id                   SERIAL PRIMARY KEY,
  period               DATE NOT NULL,
  meetup_member_id     TEXT NOT NULL CHECK (meetup_member_id ~ '^[0-9]{1,20}$'),
  classification       TEXT NOT NULL CHECK (classification IN ('warning', 'suspension')),
  status               TEXT NOT NULL DEFAULT 'new' CHECK (status IN
    ('new','warning_copied','warning_sent','on_hold','suspended','skipped','voided')),
  notes                TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  suspension_record_id INTEGER REFERENCES suspension_records(id),
  in_latest_snapshot   BOOLEAN NOT NULL DEFAULT true,
  version              INTEGER NOT NULL DEFAULT 1,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           TEXT,
  UNIQUE (period, meetup_member_id)
);
CREATE TABLE IF NOT EXISTS noshow_workspace_events (
  id          BIGSERIAL PRIMARY KEY,
  row_id      INTEGER NOT NULL REFERENCES noshow_workspace_rows(id),
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  old_status  TEXT NOT NULL,
  new_status  TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS noshow_workspace_events_row_idx ON noshow_workspace_events (row_id, id);
```

## Which months get a workspace

Rows are synced from the no-show snapshot for every month from `WORKSPACE_FIRST_PERIOD` (2026-09) through the current month, the open month included, never for the whole backfill. Older months stay read-only history (PR 3).

## Suspensions recorded outside the workspace

- **Date convention:** the suspension date is a Pacific calendar date stored as UTC midnight, exactly as `parseUtcDateStrict` does for `/meetup_record_suspension`.
- **Before inserting** (inside the action's transaction): look for a live suspension for the member in the card's link window (`linkWindow`), `<YYYY-MM-01>T00:00:00Z <= suspended_at < <the 1st of the month after next>T00:00:00Z` (UTC midnights, the `suspensionCutoff` convention; Pacific midnight would miss one dated the 1st), that no workspace row links yet. A September case suspended in October can be linked from September's card; once linked, October's card cannot take it (the one-row-per-record unique index is the backstop). The month page lists and offers the same window. The same-date ON CONFLICT link stays outside it. If one exists, refuse and offer the `link_suspension` action, which sets `suspension_record_id` and status `suspended` without inserting. A record another row already links is never offered.
- **Overlap:** a new suspension whose range overlaps any live suspension of the member, linked or not, is refused and nothing is written. An override may come later.
- **Out of order (Hai, 2026-10-17):** a new suspension dated before any live suspension of the member (`suspended_at` strictly after the chosen day) is refused as `out-of-order`, carrying the latest such record's id and date, and nothing is written. Check order: bad date, link offer, overlap, then out-of-order as the last check before the insert, so a same-day record that appears after the overlap check still reaches the ON CONFLICT link. The route sends it back to the confirm page with `?result=out-of-order`; that page names the latest live record's date. The confirm page's date `min` is the later of the month's 1st and the day after the last day of the member's live records (`?date=` below it falls back to today); when that is after today it shows a fixed "can't be recorded from here right now" line and no form. The POST stays the authority. Workspace only: the `/meetup_record_suspension` CSV import is also the historical backfill and legitimately records older records after newer ones.
- **Who:** recording, linking and voiding are for the 1.5 Leadership Team only, checked live against Discord at the moment of the action; if Discord cannot be reached the action is refused. The month page shows those controls from a 60-second cache of that answer, for display only.
- **Same-date conflict:** an empty `RETURNING` from the `ON CONFLICT … DO NOTHING` insert is treated as that same conflict, and the existing row is linked.
- **Suspension state renders live:** the page joins `suspension_records` at render time, so a void done with `/meetup_void_suspension` shows immediately.

## Transition rules (`src/lib/workspace/transitions.ts`, pure)

| Action | Allowed from | To | Note required | Classification |
|---|---|---|---|---|
| `copy_warning` | `new`, `warning_copied` | `warning_copied` | no | warning |
| `mark_sent` | `new`, `warning_copied` | `warning_sent` | no | warning |
| `hold` | `new`, `warning_copied`, `warning_sent` | `on_hold` | yes | any |
| `skip` | `new`, `warning_copied`, `warning_sent`, `on_hold` | `skipped` | yes | any |
| `reopen` | `on_hold`, `skipped` | the status before the hold/skip, read from the events log (so `warning_sent` is remembered and the warning can't be sent twice) | no | any |
| `record_suspension` | `new`, `warning_copied`, `warning_sent`, `on_hold`, `voided` | `suspended` | no | suspension |
| `link_suspension` | `new`, `warning_copied`, `warning_sent`, `on_hold`, `voided` | `suspended` | no | suspension |
| `void` | `suspended` | `voided` | yes (void reason) | any |
| `edit_notes` | any | unchanged | n/a | any |

`reopen` replaces the earlier `release_hold`. "Copy suspension message" is client-only: it changes no status and writes nothing, so it is not an action. `record_suspension`, `link_suspension` and `void` are Leadership-only (`LEADERSHIP_ONLY_ACTIONS`).

## Tasks

| # | Task | Tests (file → names) | Acceptance |
|---|---|---|---|
| 4.1 | Schema + repository; suspension insert/void inside the workspace transaction (`insertSuspensionInTx`, `voidSuspensionInTx` exported from `postgresSuspensionRepository.ts`, sharing its SQL) | `tst/integration/postgresNoShowWorkspaceRepository.test.ts` → `creates the suspension table first on a fresh database`, `sync from snapshot is idempotent and keeps edited rows`, `marks rows missing from a rebuild`, `refuses a stale version and writes nothing`, `rolls back the suspension when the workspace update fails`, `refuses when a live suspension after the period start exists and offers to link it`, `same-date ON CONFLICT links the existing row`, `every action writes exactly one event row`, `events are never updated` | |
| 4.2 | Transitions | `tst/lib/workspace/transitions.test.ts` → full matrix: every (status, action, classification) triple → allowed or refused; `note required for hold, skip, void`, `blank-after-trim note refused`, `reopen restores warning_sent`, `reopen restores new`, `record_suspension allowed from voided` | Mutation-check |
| 4.3 | Templates | `tst/lib/workspace/templates.test.ts` → `fee doubles: $10, $20, $40`, `days double: 30, 60, 120`, `host waiver omits the fee sentence`, `first name is the first word of the Meetup name, falls back to "there"`, `no-show list uses Pacific dates`, `end_date is the last suspended day (suspension date + days - 1)`, `links use NO_SHOW_POLICY_URL and NO_SHOW_APPEAL_URL`, `text is plain (escaped only when rendered)` | Templates copied verbatim from the spec. Constants: `NO_SHOW_POLICY_URL = 'https://15genasian.notion.site/1b1176bcb5de453687cd7aa5c0cd239b'`, `NO_SHOW_APPEAL_URL = 'https://forms.gle/tPiPYQ2DpAVZPL1T9'` |
| 4.4 | Service: actions + moderation log + live upcoming RSVPs / act-by / 💵 | `tst/lib/workspace/service.test.ts` → `record suspension writes the same row /meetup_record_suspension would`, `duration follows 30 × 2^prior as of the chosen date`, `logs each action to the moderation channel naming the actor as <@id>`, `upcoming RSVPs and act-by are computed live and cached ≤6h (derived fields only)`, `raw descriptions never reach Postgres`, `Meetup down shows "Meetup unavailable"` | Parity test compares against `recordCsvRows` output for the same member/date |
| 4.5 | Routes + page (registered via `protectedRoutes`) | `tst/web/routes/workspace.test.ts` → `every action requires CSRF` (from `protectedRouteList`), `stale version → 409 "someone just updated this, reload"`, `Open on Meetup only for digit ids`, `record suspension needs the confirm step`, `notes are escaped in the card and history`, `copy reads the readonly textarea`, `action rate limit` | Form POSTs only |
| 4.6 | Outcomes on no-show history (PR 3 page) | `noShowHistory.test.ts` → `shows workspace outcome per member` | |
| 4.7 | Manual walkthrough + PR | Hai and Stacey walk one month end to end on local data | Draft PR; adds `NO_SHOW_POLICY_URL` / `NO_SHOW_APPEAL_URL` constants |

# Cookie-Free OAuth & Sync V2 Launch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the session-cookie-bound grant OAuth flow with a cookie-free state-in-URL chain (Discord → Meetup), smooth and brand every step, and prepare the V1→V2 button swap — Phase 1 of the spec's rollout.

**Architecture:** State is a UUID bound to the clicking Discord user in the existing cache; it rides the `state` query parameter through the whole chain, so no request depends on cookies. arctic handles Discord OAuth and Meetup URL construction behind a thin wrapper; the Meetup token exchange is hand-rolled (its endpoint wants credentials in the form body; arctic's generic client sends HTTP Basic). `grant` and `express-session` are deleted.

**Tech Stack:** TypeScript (ESM, tsx), Express 5, discord.js 14 + discordx, arctic ^3.7, vitest + supertest + nock 14 (intercepts native fetch), Heroku.

**Spec:** `docs/superpowers/specs/2026-08-14-oauth-v2-launch-design.md` — read it first; this plan implements its Phase 1 (V1 handler deletion is Phase 2, deliberately NOT in this plan).

## Global Constraints

- ESM project: **all relative imports end in `.js`** even from `.ts` files. Package manager is **yarn**.
- Unit tests under `tst/` mirror `src/`; no network (nock everything). Integration tests under `tst/integration/` run via `yarn test:integration`.
- `npx tsc --noEmit` baseline has pre-existing dependency errors inside node_modules only; the gate is `npx tsc --noEmit 2>&1 | grep -v node_modules` → empty.
- Lint must pass (`yarn lint`); commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Redirect URIs are registered with the providers and must not change:** always `debugRedirect(`${BASE_DISCORD_BOT_URL}/connect/<provider>/callback`)` — the same value in the authorize URL and in the token exchange.
- OAuth endpoints (verified): Discord authorize `https://discord.com/oauth2/authorize` (arctic's provider), Discord token `https://discord.com/api/oauth2/token`; Meetup authorize `https://secure.meetup.com/oauth2/authorize`, Meetup token `https://secure.meetup.com/oauth2/access`.
- Discord scopes exactly `[OAuth2Scopes.Identify, OAuth2Scopes.RoleConnectionsWrite]`; Meetup scopes `BASIC_MEETUP_AUTH_SCOPES`.
- ~~Discord authorize always carries `prompt=none`.~~ **Superseded during implementation:** `prompt=none` is never sent. At launch nobody is a returning authorizer, and when iOS lands the round-trip in a browser signed into a different Discord account it silently issues tokens for the wrong account instead of prompting. The later sections of this plan still describe the original intent; the code and its tests are authoritative.
- Cache key contracts (existing consumers depend on them): `maskedUserId-{state}` → Discord user ID; `{discordUserId}-discord-tokens` and `{discordUserId}-meetup-tokens` → JSON `Tokens` (`{ accessToken, refreshToken, expiresAt }`).
- **The V1 button (`sync_meetup_account`) must keep working after every task in this plan** — Phase 1 ships with V1 still live.
- IDs: guild `912461362289061939`, welcome channel `1180262246685868303`, get-verified channel `1091256923703222293`.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/client/oauth/state.ts` (new) | `createOAuthState` / `resolveOAuthState` — the uuid↔user cache binding |
| `src/lib/client/oauth/providers.ts` (new) | arctic wrapper: authorize URLs, code exchanges, `fetchDiscordUserId` |
| `src/util/meetup.ts` (modify) | `showMeetupTokenUrl` uses `createOAuthState` (V1 path, unchanged behavior) |
| `src/constants.ts` (modify) | `GUILD_ID`, `WELCOME_CHANNEL_ID`, `GET_VERIFIED_CHANNEL_ID` |
| `src/templates/authLanding.ts` (modify) | success → welcome-channel deep link; error → get-verified deep link |
| `src/app.ts` (rewrite) | cookie-free routes; grant/express-session gone |
| `src/configuration.ts` (modify) | drop the `grant` section |
| `package.json` (modify) | + arctic; − grant, express-session, @types/express-session, cookie-signature, @types/cookie-signature, grant resolution pin |
| `src/lib/helpers/onboardUser.ts` (modify) | export `onboardUserCommon` |
| `src/buttonMenu/meetup/syncAccountV2.ts` (modify) | consolidation + per-user OAuth link button |
| `scripts/swapVerifyButton.ts` (new) | one-off button swap with `--rollback` |
| `tst/lib/client/oauth/state.test.ts` (new) | state helper |
| `tst/lib/client/oauth/providers.test.ts` (new) | URL construction + nock'd exchanges |
| `tst/templates/authLanding.test.ts` (new) | landing-page links |
| `tst/integration/app.routes.test.ts` (replace) | cookie-less chain + error paths |

---

### Task 1: OAuth state helper

**Files:**
- Create: `src/lib/client/oauth/state.ts`
- Modify: `src/util/meetup.ts:20-31` (showMeetupTokenUrl)
- Test: `tst/lib/client/oauth/state.test.ts`

**Interfaces:**
- Consumes: `ApplicationCache` from `src/util/cache.js` (existing), `uuid`.
- Produces (used by Tasks 4, 5): `createOAuthState(discordUserId: string): Promise<string>` and `resolveOAuthState(state: string): Promise<string | undefined>`. Key format stays `maskedUserId-{uuid}` — V1 and the existing meetup callback keep working unmodified.

- [ ] **Step 1: Write the failing test**

Create `tst/lib/client/oauth/state.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import {
  createOAuthState,
  resolveOAuthState,
} from '../../../../src/lib/client/oauth/state.js';

// Uses the real InMemoryCache singleton (no REDISCLOUD_URL in unit tests);
// uuid states are unique per call so tests don't collide.
describe('oauth state', () => {
  it('round-trips a state to the creating user', async () => {
    const state = await createOAuthState('discord-123');
    expect(state).toMatch(/^[0-9a-f-]{36}$/);
    expect(await resolveOAuthState(state)).toBe('discord-123');
  });

  it('returns undefined for unknown or empty state', async () => {
    expect(await resolveOAuthState('unknown-state')).toBeUndefined();
    expect(await resolveOAuthState('')).toBeUndefined();
  });

  it('issues distinct states per call', async () => {
    const a = await createOAuthState('discord-123');
    const b = await createOAuthState('discord-123');
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tst/lib/client/oauth/state.test.ts`
Expected: FAIL — cannot resolve `state.js`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/client/oauth/state.ts`:

```typescript
import { v4 as uuidv4 } from 'uuid';

import { ApplicationCache } from '../../../util/cache.js';

const STATE_KEY_PREFIX = 'maskedUserId-';

/**
 * Binds a fresh OAuth state (uuid) to the Discord user who initiated the
 * flow. The state rides the OAuth `state` query parameter end to end, so the
 * flow never depends on cookies (the old grant/express-session flow broke
 * whenever iOS finished the round-trip in a different browser context).
 */
export async function createOAuthState(discordUserId: string): Promise<string> {
  const state = uuidv4();
  const cache = await ApplicationCache();
  await cache.set(`${STATE_KEY_PREFIX}${state}`, discordUserId);
  return state;
}

export async function resolveOAuthState(
  state: string,
): Promise<string | undefined> {
  if (!state) {
    return undefined;
  }
  const cache = await ApplicationCache();
  return cache.get(`${STATE_KEY_PREFIX}${state}`);
}
```

In `src/util/meetup.ts`, replace the body of `showMeetupTokenUrl`'s state setup (the `uuidv4()` + `cache.set` lines) with the helper, keeping everything else identical:

```typescript
async function showMeetupTokenUrl(
  interaction: ButtonInteraction | CommandInteraction | ModalSubmitInteraction,
) {
  const maskedUserId = await createOAuthState(interaction.user.id);
  logger.info(
    `Setting maskedUserId=${maskedUserId} for ${interaction.user.username}`,
  );

  const oauthUrl = generateOAuthUrl('meetup', { state: maskedUserId });
  // ... button + editReply exactly as before
```

Remove the now-unused `uuidv4` and `ApplicationCache` imports from `meetup.ts` (the cache import stays if `withMeetupClient` still uses it — it does; keep it). Add `import { createOAuthState } from '../lib/client/oauth/state.js';`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test`
Expected: new suite PASS; all existing suites still green (V1 flow behavior unchanged — same key format).

- [ ] **Step 5: Lint and commit**

```bash
yarn lint
git add src/lib/client/oauth/state.ts src/util/meetup.ts tst/lib/client/oauth/state.test.ts
git commit -m "feat: extract cookie-free OAuth state helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: arctic provider wrapper

**Files:**
- Create: `src/lib/client/oauth/providers.ts`
- Modify: `package.json` (arctic is already in the worktree's node_modules from plan prep — commit the dependency)
- Test: `tst/lib/client/oauth/providers.test.ts`

**Interfaces:**
- Consumes: `Configuration` (`discord.oauthClientId/oauthSecret`, `meetup.apiKey/apiSecret`), `BASE_DISCORD_BOT_URL`, `debugRedirect`, `BASIC_MEETUP_AUTH_SCOPES` from `src/constants.js`, `Tokens`/`APIAccessTokenResponse` from `src/lib/client/discord/types.js`, `arctic`.
- Produces (used by Task 4):
  - `buildDiscordAuthUrl(state: string): string` — includes `prompt=none`
  - `exchangeDiscordCode(code: string): Promise<Tokens>`
  - `fetchDiscordUserId(accessToken: string): Promise<string>` — GET `https://discord.com/api/v10/users/@me`
  - `buildMeetupAuthUrl(state: string): string`
  - `exchangeMeetupCode(code: string): Promise<Tokens>` — hand-rolled form-body POST

- [ ] **Step 1: Ensure the dependency is recorded**

Run: `grep '"arctic"' package.json || yarn add arctic`
Expected: `"arctic": "^3.7.0"` present in dependencies (it was installed during plan preparation; if missing, the yarn add fixes it).

- [ ] **Step 2: Write the failing test**

Create `tst/lib/client/oauth/providers.test.ts`:

```typescript
import nock from 'nock';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildDiscordAuthUrl,
  buildMeetupAuthUrl,
  exchangeDiscordCode,
  exchangeMeetupCode,
  fetchDiscordUserId,
} from '../../../../src/lib/client/oauth/providers.js';

beforeAll(() => {
  process.env.DISCORD_CLIENT_ID ??= 'discord-client-id';
  process.env.DISCORD_SECRET ??= 'discord-secret';
  process.env.MEETUP_KEY ??= 'meetup-key';
  process.env.MEETUP_SECRET ??= 'meetup-secret';
});

afterEach(() => {
  nock.cleanAll();
});

describe('authorize URL construction', () => {
  it('builds the Discord URL with state, scopes, and prompt=none', () => {
    const url = new URL(buildDiscordAuthUrl('state-abc'));
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('prompt')).toBe('none');
    expect(url.searchParams.get('scope')).toContain('identify');
    expect(url.searchParams.get('scope')).toContain('role_connections.write');
    expect(url.searchParams.get('redirect_uri')).toContain('/redirect/');
  });

  it('builds the Meetup URL with state and scope', () => {
    const url = new URL(buildMeetupAuthUrl('state-abc'));
    expect(url.origin + url.pathname).toBe(
      'https://secure.meetup.com/oauth2/authorize',
    );
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('scope')).toBe('basic');
  });
});

describe('exchangeMeetupCode', () => {
  it('POSTs credentials in the form body and maps the token response', async () => {
    let capturedBody = '';
    nock('https://secure.meetup.com')
      .post('/oauth2/access', (body) => {
        capturedBody = new URLSearchParams(
          body as Record<string, string>,
        ).toString();
        return true;
      })
      .reply(200, {
        access_token: 'meetup-access',
        refresh_token: 'meetup-refresh',
        expires_in: 3600,
      });

    const tokens = await exchangeMeetupCode('the-code');

    expect(capturedBody).toContain('grant_type=authorization_code');
    expect(capturedBody).toContain('code=the-code');
    expect(capturedBody).toContain('client_id=');
    expect(capturedBody).toContain('client_secret=');
    expect(tokens.accessToken).toBe('meetup-access');
    expect(tokens.refreshToken).toBe('meetup-refresh');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it('throws a descriptive error on a non-2xx response', async () => {
    nock('https://secure.meetup.com')
      .post('/oauth2/access')
      .reply(400, { error: 'invalid_grant' });

    await expect(exchangeMeetupCode('bad-code')).rejects.toThrow(
      /Meetup token exchange failed/,
    );
  });
});

describe('exchangeDiscordCode', () => {
  it('maps arctic tokens to the Tokens shape', async () => {
    nock('https://discord.com').post('/api/oauth2/token').reply(200, {
      access_token: 'discord-access',
      refresh_token: 'discord-refresh',
      token_type: 'Bearer',
      expires_in: 604800,
    });

    const tokens = await exchangeDiscordCode('the-code');
    expect(tokens.accessToken).toBe('discord-access');
    expect(tokens.refreshToken).toBe('discord-refresh');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('fetchDiscordUserId', () => {
  it('returns the id from /users/@me', async () => {
    nock('https://discord.com')
      .get('/api/v10/users/@me')
      .matchHeader('authorization', 'Bearer discord-access')
      .reply(200, { id: '4242', username: 'tester' });

    expect(await fetchDiscordUserId('discord-access')).toBe('4242');
  });

  it('throws on a non-2xx response', async () => {
    nock('https://discord.com').get('/api/v10/users/@me').reply(401, {});
    await expect(fetchDiscordUserId('bad')).rejects.toThrow(
      /Discord profile fetch failed/,
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `yarn test tst/lib/client/oauth/providers.test.ts`
Expected: FAIL — cannot resolve `providers.js`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/client/oauth/providers.ts`:

```typescript
import { Discord, OAuth2Client, OAuth2Tokens } from 'arctic';
import { OAuth2Scopes } from 'discord.js';

import Configuration from '../../../configuration.js';
import {
  BASE_DISCORD_BOT_URL,
  BASIC_MEETUP_AUTH_SCOPES,
  debugRedirect,
} from '../../../constants.js';
import { APIAccessTokenResponse, Tokens } from '../discord/types.js';

const MEETUP_AUTHORIZE_ENDPOINT = 'https://secure.meetup.com/oauth2/authorize';
const MEETUP_TOKEN_ENDPOINT = 'https://secure.meetup.com/oauth2/access';
const DISCORD_PROFILE_ENDPOINT = 'https://discord.com/api/v10/users/@me';

// Registered with the providers; must be byte-identical in the authorize URL
// and the token exchange. debugRedirect keeps local dev working through the
// production /redirect trampoline.
const discordRedirectUri = () =>
  debugRedirect(`${BASE_DISCORD_BOT_URL}/connect/discord/callback`);
const meetupRedirectUri = () =>
  debugRedirect(`${BASE_DISCORD_BOT_URL}/connect/meetup/callback`);

function toTokens(tokens: OAuth2Tokens): Tokens {
  return {
    accessToken: tokens.accessToken(),
    refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : '',
    expiresAt: tokens.accessTokenExpiresAt().getTime(),
  };
}

const discordProvider = () =>
  new Discord(
    Configuration.discord.oauthClientId,
    Configuration.discord.oauthSecret,
    discordRedirectUri(),
  );

export function buildDiscordAuthUrl(state: string): string {
  const url = discordProvider().createAuthorizationURL(state, null, [
    OAuth2Scopes.Identify,
    OAuth2Scopes.RoleConnectionsWrite,
  ]);
  // Returning users who already granted these scopes skip the consent screen.
  url.searchParams.set('prompt', 'none');
  return url.toString();
}

export async function exchangeDiscordCode(code: string): Promise<Tokens> {
  return toTokens(await discordProvider().validateAuthorizationCode(code, null));
}

export async function fetchDiscordUserId(accessToken: string): Promise<string> {
  const response = await fetch(DISCORD_PROFILE_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `Discord profile fetch failed: [${response.status}] ${await response.text()}`,
    );
  }
  const profile = (await response.json()) as { id: string };
  return profile.id;
}

export function buildMeetupAuthUrl(state: string): string {
  const client = new OAuth2Client(
    Configuration.meetup.apiKey,
    Configuration.meetup.apiSecret,
    meetupRedirectUri(),
  );
  return client
    .createAuthorizationURL(
      MEETUP_AUTHORIZE_ENDPOINT,
      state,
      BASIC_MEETUP_AUTH_SCOPES,
    )
    .toString();
}

// Hand-rolled: Meetup's token endpoint expects client credentials in the
// form body (the old grant flow sent them that way); arctic's generic client
// would send HTTP Basic instead.
export async function exchangeMeetupCode(code: string): Promise<Tokens> {
  const body = new URLSearchParams({
    client_id: Configuration.meetup.apiKey,
    client_secret: Configuration.meetup.apiSecret,
    grant_type: 'authorization_code',
    redirect_uri: meetupRedirectUri(),
    code,
  });
  const response = await fetch(MEETUP_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `Meetup token exchange failed: [${response.status}] ${await response.text()}`,
    );
  }
  const raw = (await response.json()) as APIAccessTokenResponse;
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: Date.now() + raw.expires_in * 1000,
  };
}
```

Note: if `OAuth2Scopes.RoleConnectionsWrite` renders as `role_connections.write` in the scope assertion but Discord's authorize page later rejects it, the fallback literal is `'role_connections.write'` — the same value the old grant config sent via discord.js enums.

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test tst/lib/client/oauth/providers.test.ts`
Expected: PASS (7 tests). If the nock interceptors don't fire, confirm nock is v14+ (`yarn why nock`) — v14 intercepts native fetch/undici.

- [ ] **Step 6: Lint and commit**

```bash
yarn lint
git add package.json yarn.lock src/lib/client/oauth/providers.ts tst/lib/client/oauth/providers.test.ts
git commit -m "feat: add arctic-backed OAuth provider wrapper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Landing-page destinations + constants

**Files:**
- Modify: `src/constants.ts` (after the log-channel constants, ~line 55)
- Modify: `src/templates/authLanding.ts:16-17` (deepLink/webLink)
- Test: `tst/templates/authLanding.test.ts`

**Interfaces:**
- Produces: `GUILD_ID`, `WELCOME_CHANNEL_ID`, `GET_VERIFIED_CHANNEL_ID` in `src/constants.js`; `getAuthLandingPage(status, message)` (same signature) now routes success → welcome channel, error → get-verified channel.

- [ ] **Step 1: Write the failing test**

Create `tst/templates/authLanding.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import {
  GET_VERIFIED_CHANNEL_ID,
  GUILD_ID,
  WELCOME_CHANNEL_ID,
} from '../../src/constants.js';
import { getAuthLandingPage } from '../../src/templates/authLanding.js';

describe('getAuthLandingPage', () => {
  it('success page deep-links to the welcome channel', () => {
    const html = getAuthLandingPage('success', 'Connected!');
    expect(html).toContain(
      `discord://-/channels/${GUILD_ID}/${WELCOME_CHANNEL_ID}`,
    );
    expect(html).toContain(
      `https://discord.com/channels/${GUILD_ID}/${WELCOME_CHANNEL_ID}`,
    );
    expect(html).toContain('Connected!');
  });

  it('error page deep-links to the get-verified channel', () => {
    const html = getAuthLandingPage('error', 'Nope.');
    expect(html).toContain(
      `discord://-/channels/${GUILD_ID}/${GET_VERIFIED_CHANNEL_ID}`,
    );
    expect(html).toContain(
      `https://discord.com/channels/${GUILD_ID}/${GET_VERIFIED_CHANNEL_ID}`,
    );
    expect(html).toContain('Nope.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tst/templates/authLanding.test.ts`
Expected: FAIL — `GUILD_ID` not exported.

- [ ] **Step 3: Implement**

In `src/constants.ts`, below the log-channel constants:

```typescript
export const GUILD_ID = '912461362289061939';
export const WELCOME_CHANNEL_ID = '1180262246685868303'; // 👋🏼welcome-to-the-server
export const GET_VERIFIED_CHANNEL_ID = '1091256923703222293'; // ✅get-verified-for-full-access
```

In `src/templates/authLanding.ts`, add the import and replace the two link constants:

```typescript
import {
  GET_VERIFIED_CHANNEL_ID,
  GUILD_ID,
  WELCOME_CHANNEL_ID,
} from '../constants.js';
```

```typescript
  const targetChannelId = isSuccess ? WELCOME_CHANNEL_ID : GET_VERIFIED_CHANNEL_ID;
  const deepLink = `discord://-/channels/${GUILD_ID}/${targetChannelId}`;
  const webLink = `https://discord.com/channels/${GUILD_ID}/${targetChannelId}`;
```

Everything else in the template (auto-redirect script, styles, button) stays as is.

- [ ] **Step 4: Run tests, lint, commit**

Run: `yarn test && yarn lint`
Expected: all green.

```bash
git add src/constants.ts src/templates/authLanding.ts tst/templates/authLanding.test.ts
git commit -m "feat: land users back in the server after OAuth

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Rewrite app.ts cookie-free; delete grant + express-session

**Files:**
- Rewrite: `src/app.ts`
- Modify: `src/configuration.ts` (drop `grant` key + `GrantConfig` import + the `ConfigurationSchema.grant` field)
- Modify: `package.json` (remove deps)
- Replace: `tst/integration/app.routes.test.ts`

**Interfaces:**
- Consumes: Task 1 `resolveOAuthState`; Task 2 provider functions; Task 3 landing pages; `ApplicationCache`.
- Produces: routes `GET /connect/discord`, `GET /connect/discord/callback`, `GET /connect/meetup`, `GET /connect/meetup/callback`, `GET /redirect/:url` (unchanged). Handlers exported by name for tests: `discordConnectHandler`, `discordConnectCallbackHandler`, `meetupConnectHandler`, `meetupConnectCallbackHandler`. **V1 compatibility:** V1's link points at `/connect/meetup?state=…`, served by the new `meetupConnectHandler`.

- [ ] **Step 1: Write the failing integration tests**

Replace the entire contents of `tst/integration/app.routes.test.ts`:

```typescript
import nock from 'nock';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import app from '../../src/app.js';
import { createOAuthState } from '../../src/lib/client/oauth/state.js';
import { ApplicationCache } from '../../src/util/cache.js';

// Every request below is a FRESH supertest client with no cookie jar: the
// chain must work when each hop arrives from a different browser context
// (the iOS failure mode that killed the grant/session flow). Assertions on
// set-cookie prove the app never even tries to establish a session.

beforeAll(() => {
  process.env.DISCORD_CLIENT_ID ??= 'discord-client-id';
  process.env.DISCORD_SECRET ??= 'discord-secret';
  process.env.MEETUP_KEY ??= 'meetup-key';
  process.env.MEETUP_SECRET ??= 'meetup-secret';
});

afterEach(() => {
  nock.cleanAll();
});

const nockDiscordExchange = () =>
  nock('https://discord.com').post('/api/oauth2/token').reply(200, {
    access_token: 'discord-access',
    refresh_token: 'discord-refresh',
    token_type: 'Bearer',
    expires_in: 604800,
  });

const nockDiscordProfile = (id: string) =>
  nock('https://discord.com')
    .get('/api/v10/users/@me')
    .reply(200, { id, username: 'tester' });

const nockMeetupExchange = () =>
  nock('https://secure.meetup.com').post('/oauth2/access').reply(200, {
    access_token: 'meetup-access',
    refresh_token: 'meetup-refresh',
    expires_in: 3600,
  });

describe('cookie-free OAuth chain', () => {
  it('completes end-to-end with a fresh client per hop and no cookies', async () => {
    const state = await createOAuthState('user-1');

    const authorize = await request(app).get(`/connect/discord?state=${state}`);
    expect(authorize.status).toBe(302);
    expect(authorize.headers.location).toContain(
      'https://discord.com/oauth2/authorize',
    );
    expect(authorize.headers.location).toContain('prompt=none');
    expect(authorize.headers['set-cookie']).toBeUndefined();

    nockDiscordExchange();
    nockDiscordProfile('user-1');
    const discordCb = await request(app).get(
      `/connect/discord/callback?state=${state}&code=dcode`,
    );
    expect(discordCb.status).toBe(307);
    expect(discordCb.headers.location).toBe(`/connect/meetup?state=${state}`);
    expect(discordCb.headers['set-cookie']).toBeUndefined();

    const meetupAuthorize = await request(app).get(
      `/connect/meetup?state=${state}`,
    );
    expect(meetupAuthorize.status).toBe(302);
    expect(meetupAuthorize.headers.location).toContain(
      'https://secure.meetup.com/oauth2/authorize',
    );

    nockMeetupExchange();
    const meetupCb = await request(app).get(
      `/connect/meetup/callback?state=${state}&code=mcode`,
    );
    expect(meetupCb.status).toBe(200);
    expect(meetupCb.text).toContain('discord://-/channels/');
    expect(meetupCb.headers['set-cookie']).toBeUndefined();

    const cache = await ApplicationCache();
    expect(JSON.parse(await cache.get('user-1-discord-tokens'))).toMatchObject({
      accessToken: 'discord-access',
    });
    expect(JSON.parse(await cache.get('user-1-meetup-tokens'))).toMatchObject({
      accessToken: 'meetup-access',
    });
  });

  it('rejects an unknown state with the expired-link page', async () => {
    for (const path of [
      '/connect/discord?state=nope',
      '/connect/meetup?state=nope',
      '/connect/discord/callback?state=nope&code=x',
      '/connect/meetup/callback?state=nope&code=x',
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(400);
      expect(res.text).toContain('expired');
    }
  });

  it('rejects a Discord account mismatch and stores nothing', async () => {
    const state = await createOAuthState('user-2');
    nockDiscordExchange();
    nockDiscordProfile('someone-else');

    const res = await request(app).get(
      `/connect/discord/callback?state=${state}&code=dcode`,
    );
    expect(res.status).toBe(400);
    expect(res.text).toContain('different Discord account');

    const cache = await ApplicationCache();
    expect(await cache.get('user-2-discord-tokens')).toBeUndefined();
  });

  it('shows the denied page when the provider returns an error', async () => {
    const state = await createOAuthState('user-3');
    const res = await request(app).get(
      `/connect/discord/callback?state=${state}&error=access_denied`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('cancelled or denied');
  });

  it('shows the failure page when the token exchange fails', async () => {
    const state = await createOAuthState('user-4');
    nock('https://secure.meetup.com').post('/oauth2/access').reply(500, {});
    const res = await request(app).get(
      `/connect/meetup/callback?state=${state}&code=bad`,
    );
    expect(res.status).toBe(502);
    expect(res.text).toContain('Could not complete');
  });

  it('keeps the /redirect trampoline working', async () => {
    const encoded = Buffer.from('http://localhost:5000/target').toString(
      'base64',
    );
    const res = await request(app).get(`/redirect/${encoded}?a=1`);
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe('http://localhost:5000/target?a=1');
  });
});
```

- [ ] **Step 2: Run to verify current state fails**

Run: `yarn test:integration tst/integration/app.routes.test.ts`
Expected: FAIL (old grant-based app still in place).

- [ ] **Step 3: Rewrite src/app.ts**

Replace the entire file:

```typescript
import express, { RequestHandler } from 'express';
import { Logger } from 'tslog';

import {
  buildDiscordAuthUrl,
  buildMeetupAuthUrl,
  exchangeDiscordCode,
  exchangeMeetupCode,
  fetchDiscordUserId,
} from './lib/client/oauth/providers.js';
import { resolveOAuthState } from './lib/client/oauth/state.js';
import { getAuthLandingPage } from './templates/authLanding.js';
import { ApplicationCache } from './util/cache.js';

const logger = new Logger({ name: 'MeetupBot' });

const app = express();

app.use(express.urlencoded({ extended: true }));

const strings = {
  expiredState:
    'This link expired or was already used. Please go back to Discord and press the button again.',
  accountMismatch:
    'This link belongs to a different Discord account. Please press the button yourself and use the link it gives you.',
  providerDenied:
    'The authorization was cancelled or denied. Please go back to Discord and try again.',
  exchangeFailed:
    'Could not complete the connection. Please go back to Discord and try again.',
  meetupSuccess: 'Connected to Meetup. Heading back to Discord…',
};

const errorPage = (
  res: Parameters<RequestHandler>[1],
  status: number,
  message: string,
) => res.status(status).send(getAuthLandingPage('error', message));

export const discordConnectHandler: RequestHandler = (async (req, res) => {
  const state = String(req.query.state ?? '');
  if (!(await resolveOAuthState(state))) {
    return errorPage(res, 400, strings.expiredState);
  }
  return res.redirect(302, buildDiscordAuthUrl(state));
}) as RequestHandler;

export const meetupConnectHandler: RequestHandler = (async (req, res) => {
  const state = String(req.query.state ?? '');
  if (!(await resolveOAuthState(state))) {
    return errorPage(res, 400, strings.expiredState);
  }
  return res.redirect(302, buildMeetupAuthUrl(state));
}) as RequestHandler;

export const discordConnectCallbackHandler: RequestHandler = (async (
  req,
  res,
) => {
  const state = String(req.query.state ?? '');
  const userId = await resolveOAuthState(state);
  if (!userId) {
    return errorPage(res, 400, strings.expiredState);
  }
  if (req.query.error || !req.query.code) {
    logger.warn(`Discord authorize denied: ${JSON.stringify(req.query)}`);
    return res.status(200).send(getAuthLandingPage('error', strings.providerDenied));
  }
  try {
    const tokens = await exchangeDiscordCode(String(req.query.code));
    const profileId = await fetchDiscordUserId(tokens.accessToken);
    if (profileId !== userId) {
      logger.warn(
        `OAuth state/account mismatch: state belongs to ${userId}, token belongs to ${profileId}`,
      );
      return errorPage(res, 400, strings.accountMismatch);
    }
    const cache = await ApplicationCache();
    await cache.set(`${userId}-discord-tokens`, JSON.stringify(tokens));
    return res.redirect(307, `/connect/meetup?state=${state}`);
  } catch (error) {
    logger.error(`Discord token exchange failed: ${String(error)}`);
    return errorPage(res, 502, strings.exchangeFailed);
  }
}) as RequestHandler;

export const meetupConnectCallbackHandler: RequestHandler = (async (
  req,
  res,
) => {
  const state = String(req.query.state ?? '');
  const userId = await resolveOAuthState(state);
  if (!userId) {
    return errorPage(res, 400, strings.expiredState);
  }
  if (req.query.error || !req.query.code) {
    logger.warn(`Meetup authorize denied: ${JSON.stringify(req.query)}`);
    return res.status(200).send(getAuthLandingPage('error', strings.providerDenied));
  }
  try {
    const tokens = await exchangeMeetupCode(String(req.query.code));
    const cache = await ApplicationCache();
    await cache.set(`${userId}-meetup-tokens`, JSON.stringify(tokens));
    return res.send(getAuthLandingPage('success', strings.meetupSuccess));
  } catch (error) {
    logger.error(`Meetup token exchange failed: ${String(error)}`);
    return errorPage(res, 502, strings.exchangeFailed);
  }
}) as RequestHandler;

app.get('/connect/discord', discordConnectHandler);
app.get('/connect/discord/callback', discordConnectCallbackHandler);
app.get('/connect/meetup', meetupConnectHandler);
app.get('/connect/meetup/callback', meetupConnectCallbackHandler);

app.get('/redirect/:url', (req, res) => {
  const { url } = req.params;
  if (url) {
    const decodedUrl = Buffer.from(url, 'base64').toString('utf-8');
    const redirectUrl = new URL(decodedUrl);
    if (req.query) {
      Object.entries(req.query).forEach(([key, value]) => {
        redirectUrl.searchParams.append(key, value.toString());
      });
    }
    logger.info(`Redirecting to ${redirectUrl.toString()}`);
    return res.redirect(307, redirectUrl.toString());
  }
  return res.send('Invalid url');
});

export default app;
```

- [ ] **Step 4: Drop grant from configuration.ts**

Remove the `GrantConfig` import, the `grant` field from `ConfigurationSchema`, and the entire `grant: { … }` block from the `Configuration` object. Nothing else in the file changes.

- [ ] **Step 5: Remove the dead dependencies**

```bash
yarn remove grant express-session
yarn remove -D @types/express-session cookie-signature @types/cookie-signature
```

Then edit `package.json` `resolutions`: delete the `"grant/request-oauth/uuid"` entry (its target is gone). Run `yarn install` after the edit to refresh the lockfile.

- [ ] **Step 6: Run everything**

Run: `yarn test && yarn test:integration && npx tsc --noEmit 2>&1 | grep -v node_modules`
Expected: unit green; integration green (nock suites) with Redis/Postgres suites skip-warning as usual; tsc gate empty. If `tsc` flags removed imports anywhere (e.g. `GrantSession` in old code), those references are dead code this task must delete.

- [ ] **Step 7: Lint and commit**

```bash
yarn lint
git add -A
git commit -m "feat: replace grant sessions with cookie-free OAuth chain

State rides the OAuth state query parameter bound to the cache, so the
flow survives iOS browser-context switches that killed session cookies
(the 'Cannot GET /' bug). grant and express-session are removed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: V2 handler consolidation + per-user link

**Files:**
- Modify: `src/lib/helpers/onboardUser.ts:75` (`onboardUserCommon` gains `export`)
- Modify: `src/buttonMenu/meetup/syncAccountV2.ts`

**Interfaces:**
- Consumes: `onboardUserCommon(interaction, userId, gender, nickname?)` (newly exported), `createOAuthState` (Task 1), `generateOAuthUrl` from `src/constants.js` (existing — builds `/connect/discord?state=…` with the debugRedirect wrapper for dev).
- Produces: no new exports. The V2 button flow now: per-user link button → cookie-free chain → shared onboarding implementation.

- [ ] **Step 1: Export the shared helper**

In `src/lib/helpers/onboardUser.ts`, change `async function onboardUserCommon(` to `export async function onboardUserCommon(`. No body changes.

- [ ] **Step 2: Rewrite the V2 handler's flow**

In `src/buttonMenu/meetup/syncAccountV2.ts`:

1. Add imports: `createOAuthState` from `../../lib/client/oauth/state.js`, `onboardUserCommon` from `../../lib/helpers/onboardUser.js`, `generateOAuthUrl` from `../../constants.js` (extend the existing constants import), and discord.js `ButtonStyle`/`ButtonBuilder` pieces are already imported.
2. Replace the OAuth-link block (the `editReply` that today points at `discordBotUrl('discord-meetup-connect')`) with a per-user link button:

```typescript
        const state = await createOAuthState(interaction.user.id);
        const oauthUrl = generateOAuthUrl('discord', { state });
        const connectButton = new ButtonBuilder()
          .setLabel('Connect Discord + Meetup')
          .setEmoji('🧲')
          .setStyle(ButtonStyle.Link)
          .setURL(oauthUrl);
        const row =
          new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
            connectButton,
          );
        await interaction.editReply({
          content: 'Please connect your Discord and Meetup accounts:',
          components: [row],
        });
```

(The spin-waits for `discordTokenKey`/`meetupTokenKey` that follow stay exactly as they are.)

3. Replace the duplicated onboarding block — the nickname-setting code (`guildMember.setNickname` and the invisible-character fallback), the gender `switch` adding lounge roles, and the `removeServerRole(guild, user.id, 'onboarding')` call — with:

```typescript
      await onboardUserCommon(
        interaction,
        cachedUser.id,
        userInfo.self.gender,
        cleanedName,
      );
```

Delete the now-unused local `strings.invisibleCharacter`, the `isAdmin` import if nothing else in the file uses it, and the `addServerRole`/`removeServerRole` imports if now unused (the reward-role calls `addRewardRole`/`removeRewardRole` stay).

- [ ] **Step 3: Verify**

Run: `yarn test && npx tsc --noEmit 2>&1 | grep -v node_modules && yarn lint`
Expected: all green; grep exits with no output. Behavior parity note for the reviewer: `onboardUserCommon` logs and role changes are identical to the deleted inline block (it was a copy).

- [ ] **Step 4: Commit**

```bash
git add src/lib/helpers/onboardUser.ts src/buttonMenu/meetup/syncAccountV2.ts
git commit -m "refactor: single onboarding implementation; per-user V2 OAuth link

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: swapVerifyButton script (with --rollback)

**Files:**
- Create: `scripts/swapVerifyButton.ts`

**Interfaces:**
- Consumes: `GET_VERIFIED_CHANNEL_ID` from `src/constants.js`; `DISCORD_API_KEY` env.
- Produces: a script run manually at rollout step 3 (NOT during this plan's execution). Forward: finds the bot message whose component has custom_id `sync_meetup_account`, replaces the button with the V2 one and appends the badge line. `--rollback`: finds `sync_meetup_account_v2`, restores the V1 button and removes the badge line.

- [ ] **Step 1: Write the script**

Create `scripts/swapVerifyButton.ts`:

```typescript
/* eslint-disable no-console */
// One-off: swaps the live Get Verified button between the V1 and V2 flows.
//   Forward:  source .env && npx tsx scripts/swapVerifyButton.ts
//   Rollback: source .env && npx tsx scripts/swapVerifyButton.ts --rollback
// Run exactly once per direction; verify in Discord afterwards.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  MessageActionRowComponentBuilder,
  TextChannel,
} from 'discord.js';

import { GET_VERIFIED_CHANNEL_ID } from '../src/constants.js';

const V1_ID = 'sync_meetup_account';
const V2_ID = 'sync_meetup_account_v2';
const BADGE_LINE =
  '\nLinking also unlocks the 1.5 profile badge on your Discord profile (member since, events attended, events hosted).';

async function main() {
  const rollback = process.argv.includes('--rollback');
  const [fromId, toId] = rollback ? [V2_ID, V1_ID] : [V1_ID, V2_ID];

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_API_KEY);

  const channel = await client.channels.fetch(GET_VERIFIED_CHANNEL_ID);
  if (!(channel instanceof TextChannel)) {
    throw new Error('get-verified channel not found or not a text channel');
  }
  const messages = await channel.messages.fetch({ limit: 50 });
  const target = messages.find(
    (message) =>
      message.author.id === client.user?.id &&
      message.components.some((row) =>
        row.components.some(
          (component) =>
            'customId' in component && component.customId === fromId,
        ),
      ),
  );
  if (!target) {
    throw new Error(`No bot message with a ${fromId} button found`);
  }

  const button = new ButtonBuilder()
    .setLabel('Link Meetup Account')
    .setEmoji('🔗')
    .setStyle(ButtonStyle.Danger)
    .setCustomId(toId);
  const row =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      button,
    );

  const baseContent = target.content.replace(BADGE_LINE, '');
  const content = rollback ? baseContent : `${baseContent}${BADGE_LINE}`;

  await target.edit({ content, components: [row] });
  console.log(
    `Swapped button ${fromId} -> ${toId} on message ${target.id} in #${channel.name}`,
  );
  await client.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck + lint only (do NOT run the script)**

Run: `npx tsc --noEmit 2>&1 | grep -v node_modules; yarn lint`
Expected: grep empty; lint clean. The script executes only at rollout step 3, after the mod smoke test.

- [ ] **Step 3: Commit**

```bash
git add scripts/swapVerifyButton.ts
git commit -m "feat: add reversible verify-button swap script

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Full verification + PR (Phase 1 complete)

**Files:** none new.

- [ ] **Step 1: Full local verification**

```bash
yarn lint && npx tsc --noEmit 2>&1 | grep -v node_modules; yarn test && yarn test:integration
```

Expected: lint clean, tsc gate empty, unit suite green, integration green (env-gated suites skip with warnings).

- [ ] **Step 2: Cross-browser mechanism check (manual, optional but recommended)**

Run the bot locally (`yarn dev`), start the flow in one browser, copy the authorize URL into a second browser, complete there. Expected: success page (pre-change this yields `Cannot GET /`). Requires real OAuth credentials in `.env`; skip if not configured locally — CI's cookie-less suite covers the mechanism.

- [ ] **Step 3: Push and create the Phase 1 PR**

Use the superpowers:finishing-a-development-branch skill. PR body must include the **post-merge rollout checklist** (spec §8): deploy; post a V2 test button in 🤖bot-testing (`/create_sync_account_button_v2`); recruit 2–3 iPhone-owning mods (≥1 with the Meetup app installed) to click through and report; run `scripts/swapVerifyButton.ts`; monitor 🟥🚨meetup-bot-alerts and the unlinked digest; rollback = `--rollback` flag. **Phase 2 (delete V1 handler, move LGBTQ button to `lgbtq.ts`) happens in a separate follow-up PR after several clean days** — it is intentionally not part of this plan.

---

## Self-Review Notes (already applied)

- Spec coverage: §1 wrapper → Task 2; §2 state → Task 1; §3 routes → Task 4 (incl. `/connect/meetup` for V1 compat); §4 landing → Task 3; §5 consolidation → Task 5; §6 swap script (+rollback) → Task 6; §7 testing → Tasks 2/3/4 + Task 7 step 2; §8 rollout Phase 1 → Task 7 (Phase 2 explicitly deferred).
- Type consistency: `Tokens` shape reused from `discord/types.js` everywhere; `createOAuthState`/`resolveOAuthState` names match across Tasks 1/4/5; handler export names match between app.ts and the integration test imports.
- Verified against installed arctic 3.7.0 typings: `Discord(clientId, secret, redirectURI)`, `createAuthorizationURL(state, codeVerifier|null, scopes): URL`, `validateAuthorizationCode(code, codeVerifier|null): Promise<OAuth2Tokens>`, `OAuth2Client(clientId, password, redirectURI).createAuthorizationURL(endpoint, state, scopes)`; `OAuth2Tokens.accessToken()/hasRefreshToken()/refreshToken()/accessTokenExpiresAt()`.
- Known judgment call recorded: Meetup exchange hand-rolled from the start (arctic generic client sends HTTP Basic; Meetup expects form-body credentials — same transport grant used).

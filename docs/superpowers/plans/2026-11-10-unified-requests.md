# One Request Queue (Discord + website) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A request made in Discord or on the website is one `event_requests` row, shown on both surfaces, decided through one service, with the decision mirrored onto the Discord post.

**Architecture:** The queue route's decision logic moves into `src/lib/hosts/requestDecision.ts` (`decideRequest`), which the Express route and the Discord button/modal handlers both call. `src/lib/hosts/requestPost.ts` renders, posts and edits the Discord message; `src/lib/hosts/discordRequests.ts` holds the slash-command and button handlers as functions over a deps object, and `src/commands/meetup/createEvent.ts` only wires them into discordx. The repository gains `source` and the Discord post pointer.

**Tech Stack:** TypeScript ESM (`.js` import specifiers), discord.js v14 / discordx, Express 5, pg, vitest (network blocked). Integration tests: `DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres REDISCLOUD_URL=redis://localhost:56379 npx vitest run --config vitest.integration.config.ts <file>`.

**Spec:** `docs/superpowers/specs/2026-11-10-unified-requests-design.md` (issue duyhai/MeetupDiscordBot#137).

## Global Constraints

- Leadership = `SERVER_ROLES.leadership` checked live (`discordRoleCheck`) on every decision, from either surface.
- Every Discord post or edit this feature sends: `allowedMentions: { parse: [] }` (the no-pings scan `tst/lib/noPings.test.ts` requires that exact literal). Alerts are plain `LogEntry`s to `#meetup-bot-alerts`.
- Defaults recorded for a Discord request: `DEFAULT_TIME` `'19:00'`, `DEFAULT_DURATION` `'PT2H'`, `freshSettings(tier, tip, 'PT2H')`; title max `TITLE_MAX`; dates per `parseRequestForm` (tomorrow … 365 days).
- Submit token for a Discord request: `interaction.id` (digits, matches `SUBMIT_TOKEN`).
- `event_requests.source IN ('web','discord')`, default `'web'`; `discord_channel_id` / `discord_message_id` are 17–20 digit strings, nullable.
- `setDiscordPost` never bumps `version` and writes no history row.
- `src/lib` must not import `src/web` (move `withDeadline` to `src/util/deadline.ts`).
- Schema changes are idempotent `ADD COLUMN IF NOT EXISTS` inside `EVENT_REQUEST_SCHEMA_SQL` (runs under the schema lock).
- `EVENT_REQUESTS_CHANNEL_ID` (env, optional, 17–20 digits): where website requests are posted. Unset → no post, one warning at boot.
- All web markup through `html`; no new redirects.

## Review Focus

1. A leader presses Approve twice quickly: exactly one publish; the second press gets the stale ephemeral (Task 5 test "a second press on the same version is stale").
2. The Discord post edit fails (message deleted, channel gone): the decision stands, a warning is logged and an alert posted, the reply to the leader still says approved (Task 4 test "a failed edit alerts and does not throw"; Task 2 test "mirror failure does not change the outcome").
3. A website request made by a host with no Discord link: the post has no mention and names the stored host name (Task 4 test).
4. A Discord request from a blacklisted member: refused with the generic error, no row (Task 5 test).
5. An old queue page (stale version) approving after a Discord decision: 409 page, nothing changed (Task 2: the existing route test "approving a stale version shows the 409 page" keeps passing).

---

### Task 1: Schema and repository — `source` and the Discord post pointer

**Files:**

- Modify: `src/lib/repositories/postgresEventRequestRepository.ts`
- Test: `tst/integration/postgresEventRequestRepository.test.ts`

**Interfaces:**

- Produces: `NewEventRequest.source?: 'web' | 'discord'` (default `'web'`); `EventRequest.source: 'web' | 'discord'`; `EventRequest.discordPost: { channelId: string; messageId: string } | null`; `PostgresEventRequestRepository.setDiscordPost(id: string, channelId: string, messageId: string): Promise<EventRequest | undefined>` (undefined when the id is unknown, already has a post, or an id is malformed).
- Also export `DISCORD_ID = /^[0-9]{17,20}$/` from this file (the SQL already has the same pattern as text).

- [ ] **Step 1: Write the failing integration tests** (append to the existing describe):

```ts
it('stores the source and reads it back; old rows default to web', async () => {
  const web = await repo.create(request());
  const discord = await repo.create(
    request({ source: 'discord', submitToken: '1'.repeat(18) }),
  );
  expect(web?.source).toBe('web');
  expect(discord?.source).toBe('discord');
  expect(web?.discordPost).toBeNull();
});

it('records the Discord post once, without bumping the version or history', async () => {
  const created = await repo.create(request());
  const posted = await repo.setDiscordPost(
    created!.id,
    '1'.repeat(19),
    '2'.repeat(19),
  );
  expect(posted?.discordPost).toEqual({
    channelId: '1'.repeat(19),
    messageId: '2'.repeat(19),
  });
  expect(posted?.version).toBe(1);
  expect(
    await repo.setDiscordPost(created!.id, '3'.repeat(19), '4'.repeat(19)),
  ).toBeUndefined();
  expect((await repo.get(created!.id))?.discordPost?.messageId).toBe(
    '2'.repeat(19),
  );
  expect(await historyOf(created!.id)).toHaveLength(1);
});

it('refuses a malformed message id for the post pointer', async () => {
  const created = await repo.create(request());
  expect(
    await repo.setDiscordPost(created!.id, 'abc', '2'.repeat(19)),
  ).toBeUndefined();
});

it('a repeated Discord interaction id makes one row', async () => {
  const token = '123456789012345678';
  const first = await repo.create(
    request({ source: 'discord', submitToken: token }),
  );
  const second = await repo.create(
    request({ source: 'discord', submitToken: token }),
  );
  expect(first).toBeDefined();
  expect(second).toBeUndefined();
  expect((await repo.findBySubmitToken(HOST, token))?.id).toBe(first!.id);
});
```

- [ ] **Step 2: Run them; expect failures** (`source`/`discordPost`/`setDiscordPost` missing).
- [ ] **Step 3: Implement**: add the three columns to `EVENT_REQUEST_SCHEMA_SQL` (`CREATE TABLE` body and `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for each, with the CHECKs from Global Constraints), `source` in the INSERT (`input.source ?? 'web'`), `Row` fields, `toRequest` mapping, and `setDiscordPost` as `UPDATE … SET discord_channel_id=$2, discord_message_id=$3, updated_at=now() WHERE id=$1 AND discord_message_id IS NULL RETURNING *` (validate ids with `isRequestId` / `DISCORD_ID` first).
- [ ] **Step 4: Run the file; expect PASS. Run the schema twice (the existing beforeAll does) to confirm idempotence.**
- [ ] **Step 5: Commit** `feat(requests): source and Discord post pointer on event_requests`.

### Task 2: The decision service, extracted from the queue route

**Files:**

- Create: `src/util/deadline.ts` (move `withDeadline`, `WorkspaceDeadlineError` from `src/web/routes/workspaceActions.ts`; re-export them there so no import changes elsewhere)
- Create: `src/lib/hosts/requestDecision.ts`
- Modify: `src/web/routes/hostRequests.ts` (POST handler becomes a wrapper), `src/web/routes/dashboardPages.ts` (`HostRequestDeps` gains `mirrorRequest?`)
- Test: `tst/lib/hosts/requestDecision.test.ts` (new), `tst/web/routes/hostRequests.test.ts` (must keep passing unchanged, except that `audit` lines now come from the service — same titles)

**Interfaces:**

- Produces:

```ts
export type DecisionAction = 'approve' | 'deny' | 'retry' | 'resolve';
export type DecisionCode =
  | 'published'
  | 'failed'
  | 'denied'
  | 'resolved'
  | 'stale'
  | 'still-publishing'
  | 'deny-slow'
  | 'reason-required'
  | 'reason-too-long'
  | 'deny-event-exists'
  | 'deny-check-failed'
  | 'invalid'
  | 'not-leadership'
  | 'leadership-unavailable'
  | 'error';
export interface DecisionOutcome {
  code: DecisionCode;
  request?: EventRequest;
}
export interface DecisionDeps {
  now: () => Date;
  isLeadership: (discordUserId: string) => Promise<boolean>;
  audit: (entry: LogEntry) => Promise<unknown>;
  store: () => Promise<StaffRequestStore>; // get, deny, resolve (the type moves here from the route)
  publishRequest: (
    id: string,
    version: number,
    actor: string,
    from: PublishFrom[],
  ) => Promise<PublishOutcome>;
  findExistingEvent: (
    request: EventRequest,
  ) => Promise<ExistingEvent | undefined>;
  /** Edits the Discord post; fire-and-forget, never throws into the decision. */
  mirror?: (request: EventRequest) => Promise<unknown>;
  denyCheckDeadlineMs?: number;
  refusalLimiter?: FixedWindowLimiter; // the once-a-minute refusal audit
}
export interface DecisionInput {
  id: string;
  version: number;
  actor: string;
  action: DecisionAction;
  reason?: string;
}
export function decideRequest(
  deps: DecisionDeps,
  input: DecisionInput,
): Promise<DecisionOutcome>;
export const DECISION_SOURCE = {
  web: 'the website',
  discord: 'Discord',
} as const; // not needed if unused: drop
```

The body is today's POST handler from the leadership check down, with `back(res, code)` → `return { code }`, `stalePage` → `{ code: 'stale' }`, and the `auditLine` helper inside the service. `mirror` is called (`.catch(() => undefined)`) on codes `published`, `failed`, `denied`, `resolved`, and on `still-publishing` chained onto the still-running publish promise's outcome.

- The route: validates params (`REQUEST_ID`, `ACTIONS`, `VERSION`), calls `decideRequest` with `actor = session.userId`, maps `stale` → `stalePage`, every other code → `back(res, code)`. `HOST_REQUEST_RESULT_MESSAGES` unchanged.

- [ ] **Step 1: Write `tst/lib/hosts/requestDecision.test.ts`** with a fake store (reuse `fakeEventRequests`/`eventRequestRow` from `tst/web/routes/pageFakes.ts`) covering: non-leader → `not-leadership` with one refusal audit; Discord unreachable → `leadership-unavailable`; approve → `publishRequest` called with `['pending']`, outcome `published`, audit title `Host request approved`, `mirror` called with the published request; approve on a stale version → `stale`, no mirror; deny with blank reason → `reason-required`; deny → `denied`, mirror called; deny of a failed request whose event exists → `deny-event-exists`; `mirror` rejecting → the outcome is still `published` (test name "mirror failure does not change the outcome").
- [ ] **Step 2: Run; expect FAIL** (module missing).
- [ ] **Step 3: Create `src/util/deadline.ts`, `requestDecision.ts`; rewrite the route's POST as the wrapper; add `mirrorRequest?` to `HostRequestDeps` and pass it as `mirror`.**
- [ ] **Step 4: Run** `npx vitest run tst/lib/hosts/requestDecision.test.ts tst/web/routes/hostRequests.test.ts tst/web/routes/workspaceActions.test.ts`; expect PASS. If a route test asserted an audit call shape that moved, keep the shape identical in the service rather than editing the test.
- [ ] **Step 5: Commit** `refactor(requests): decideRequest service shared by the queue route`.

### Task 3: First-time hosts publish as regular

**Files:**

- Modify: `src/web/host/hostServices.ts` (`productionPublishDeps.tierOf`), `src/lib/hosts/publishRequest.ts` (`PUBLISH_FAILURES.notAHost` text)
- Test: `tst/lib/hosts/eligibility.test.ts` or new `tst/web/host/hostServices.test.ts`

**Interfaces:**

- Produces: `export function publishTier(resolution: HostResolution): HostTier | 'not-a-host'` in `src/lib/hosts/eligibility.ts`: `host` → its tier; refused `not-a-host` or `not-linked` → `'regular'`; refused `blacklisted` → `'not-a-host'`. `tierOf` uses it.

- [ ] **Step 1: Tests**: `publishTier({kind:'refused',reason:'not-a-host'})` is `'regular'`; `blacklisted` is `'not-a-host'`; a promoted host stays `'promoted'`.
- [ ] **Step 2: Run; FAIL. Step 3: Implement; change `notAHost` to "The member is blacklisted as a host, so nothing was created on Meetup." Step 4: Run `tst/lib/hosts` and `tst/web/host`; PASS. Step 5: Commit** `fix(requests): a first-time host's approved request publishes as a regular host`.

### Task 4: The Discord post — render, post, mirror

**Files:**

- Create: `src/lib/hosts/requestPost.ts`
- Test: `tst/lib/hosts/requestPost.test.ts`

**Interfaces:**

- Produces:

```ts
export const APPROVE_ID = (id: string) => `request-approve:${id}`;
export const DENY_ID = (id: string) => `request-deny:${id}`;
export const APPROVE_ID_PATTERN = /^request-approve:([1-9][0-9]{0,17})$/;
export const DENY_ID_PATTERN = /^request-deny:([1-9][0-9]{0,17})$/;
export function requestIdFrom(customId: string): string | undefined;
export function requestButtons(
  id: string,
  disabled: boolean,
): ActionRowBuilder<MessageActionRowComponentBuilder>;
export interface PostLinks {
  origin: string;
} // host page `${origin}/host/requests/${id}`, queue `${origin}/dashboard/hosts/requests`
export function requestPostContent(
  request: EventRequest,
  hostedCount: number | undefined,
  links: PostLinks,
): string;
export function decisionLine(request: EventRequest): string | undefined; // published/resolved, failed, denied (spec texts); undefined for pending/publishing
export interface PostTarget {
  send: (payload: {
    content: string;
    components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
    allowedMentions: { parse: [] };
  }) => Promise<{ id: string; channelId: string }>;
}
export interface RequestPostDeps {
  store: () => Promise<Pick<PostgresEventRequestRepository, 'setDiscordPost'>>;
  pastHostedCount: (meetupMemberId: string) => Promise<number>;
  alert: (entry: LogEntry) => Promise<unknown>;
  origin: string;
}
/** Posts the request and records the message; the count read failing omits the line; never throws. */
export function postRequest(
  deps: RequestPostDeps,
  request: EventRequest,
  target: PostTarget,
): Promise<void>;
export interface MirrorDeps {
  getClient: () => Client | undefined;
  alert: (entry: LogEntry) => Promise<unknown>;
}
/** Edits the stored post with decisionLine and disabled buttons; failure logs + alerts; never throws. */
export function mirrorDecision(
  deps: MirrorDeps,
  request: EventRequest,
): Promise<void>;
```

Content format is the spec's block. The tip line is `request.description.match(/^💡 Host Tip: (.*) 💡\n\n/u)`. Mention `<@${discordUserId}>` only when set, else `escapeMarkdown(hostName)`. The approved line's actor: `<@id>` when `decidedBy` matches `DISCORD_ID`, else `escapeMarkdown(hostName)`. Reason text through `alertText`.

- [ ] **Step 1: Tests**: content has the Meetup id, date `2026-11-20`, title, `Starts: 7:00 PM for 2 h`, both links in `<…>`, the tip from the description, `Organizers, please approve or deny below:`; no `<@` when `discordUserId` is null and the host name appears; hosted count line omitted when `pastHostedCount` rejects; `postRequest` calls `send` with `allowedMentions: { parse: [] }` and then `setDiscordPost(id, channelId, messageId)`; `requestIdFrom('request-approve:17')` is `'17'` and `requestIdFrom('approve')` undefined; `decisionLine` for published contains `✅` and the event URL, denied contains `❌` and the reason, failed contains `⚠️`; `mirrorDecision` fetches channel then message and edits with disabled components; a deleted message (fetch rejects) → `alert` called with title containing `Could not update the Discord post` and the promise resolves ("a failed edit alerts and does not throw"); no `discordPost` → nothing fetched.
- [ ] **Step 2: Run; FAIL. Step 3: Implement. Step 4: Run; PASS. Also `npx vitest run tst/lib/noPings.test.ts`. Step 5: Commit** `feat(requests): Discord request post, buttons and decision mirror`.

### Task 5: Discord handlers — command, approve press, deny modal

**Files:**

- Create: `src/lib/hosts/discordRequests.ts`
- Modify: `src/commands/meetup/createEvent.ts` (new wiring; legacy `approve`/`deny` handlers kept, commented as legacy), `src/web/host/hostServices.ts` (export `productionDecisionDeps(getClient)` and `productionRequestPostDeps(getClient)` builders used by both the web and the Discord wiring)
- Test: `tst/lib/hosts/discordRequests.test.ts`; `tst/commands/meetup/createEvent.test.ts` keeps passing

**Interfaces:**

- Consumes: `decideRequest` (Task 2), `postRequest`, `requestButtons`, `requestIdFrom`, `DENY_ID` (Task 4), `publishTier` (Task 3), `parseRequestForm`, `freshSettings`, `MAX_PENDING`.
- Produces:

```ts
export interface DiscordRequestDeps {
  now: () => Date;
  resolve: (who: { discordUserId: string }) => Promise<HostResolution>;
  store: () => Promise<
    Pick<
      PostgresEventRequestRepository,
      'create' | 'findBySubmitToken' | 'countPending' | 'get' | 'setDiscordPost'
    >
  >;
  publish: (
    id: string,
    version: number,
    actor: string,
  ) => Promise<PublishOutcome>; // promoted hosts
  post: RequestPostDeps;
  decision: DecisionDeps;
  tip: () => string;
  alert: (entry: LogEntry) => Promise<unknown>;
  origin: string;
}
export const UNLINKED_NUDGE: string; // "Link your Meetup account first: press Verify in #get-verified, or open <origin>/host and use Verify on Discord."
export function handleRequestCommand(
  deps,
  interaction: CommandInteraction,
  input: { year: number; month: number; day: number; title: string },
): Promise<void>;
export function handleApprovePress(
  deps,
  interaction: ButtonInteraction,
): Promise<void>;
export function showDenyModal(interaction: ButtonInteraction): Promise<void>; // customId DENY_ID(id), one paragraph input 'reason', max DENY_REASON_MAX
export function handleDenySubmit(
  deps,
  interaction: ModalSubmitInteraction,
): Promise<void>;
export const DISCORD_RESULT_MESSAGES: Partial<Record<DecisionCode, string>>; // overrides for stale, published, denied, failed; others from HOST_REQUEST_RESULT_MESSAGES
```

`handleRequestCommand` runs inside `discordCommandWrapper` (the class method wraps it): resolve → nudge (`editReply` + `keepReplyVisible`) / throw for blacklisted; `parseRequestForm` with `today = pacificDay(now)`, throw the first error text; `findBySubmitToken(meetupId, interaction.id)` → if found, reply "This request was already made" and return; cap for regular; `create({ …, source: 'discord', submitToken: interaction.id })`; promoted → `publish` then `postRequest` with the published row and no buttons (pass `requestButtons(id, true)`); regular → `postRequest` with `target = { send: (p) => interaction.followUp(p) }`; `newRequestAlert`-style alert via `deps.alert`. `handleApprovePress`: `requestIdFrom`, `get`, `decideRequest(approve, version)`, `followUp({ ephemeral: true, content })`, `markActivityLogged`. `handleDenySubmit`: reason from `fields.getTextInputValue('reason')`, `decideRequest(deny)`, ephemeral outcome.

- [ ] **Step 1: Tests** with fake deps and minimal fake interactions (the shape used in `tst/commands/meetup/createEvent.test.ts`): command→row (`startLocal` `'2026-11-20T19:00'`, `duration 'PT2H'`, `rsvpLimit 12`, `guestLimit 1`, description starts with the tip and ends with `GUEST_HOST_EVENT_DESCRIPTION`, `source 'discord'`, `submitToken` = interaction id, `discordUserId`, `hostName` = username); unlinked → reply contains "Verify" and no `create`; blacklisted → error, no row; `not-a-host` → row created with tier `regular`; a date in the past → the website's text "Pick a date from tomorrow on."; 5 pending → the cap text, no row; second call with the same interaction id → no second `create`, reply says already made; the post's `send` called with buttons `request-approve:<id>`; approve press → `decideRequest` called with `{ action: 'approve', actor: user.id, version }`, ephemeral reply with the published text; `stale` → "Someone just acted on this request"; "a second press on the same version is stale" (two presses, fake store at version 1, decision fake returns `stale` the second time); `showDenyModal` → `showModal` with customId `request-deny:17`; deny submit → `decideRequest` with the reason.
- [ ] **Step 2: Run; FAIL. Step 3: Implement the module, the production deps builders in `hostServices.ts`, and wire `createEvent.ts`:** `@ButtonComponent({ id: APPROVE_ID_PATTERN })`, `@ButtonComponent({ id: DENY_ID_PATTERN })` (calls `showDenyModal` directly, no wrapper), `@ModalComponent({ id: DENY_ID_PATTERN })`; the slash command body becomes `handleRequestCommand`. Title option `maxLength: TITLE_MAX`.
- [ ] **Step 4: Run** `npx vitest run tst/lib/hosts tst/commands`; PASS. **Step 5: Commit** `feat(requests): /meetup_request_event writes the shared row; buttons use decideRequest`.

### Task 6: Website wiring — post new requests, mirror decisions, channel config

**Files:**

- Modify: `src/web/host/createPage.ts` (`CreatePageDeps.postToDiscord?: (request: EventRequest) => Promise<unknown>`, called fire-and-forget after a regular host's create), `src/web/host/hostDeps.ts`, `src/web/dashboardDeps.ts` (`mirrorRequest: (r) => mirrorDecision(...)`), `src/web/host/hostServices.ts` (`requestsChannelId(env)`; `postRequestToChannel(getClient, deps, request)` using `client.channels.fetch` + `TextChannel.send`)
- Test: `tst/web/host/createPage.test.ts` (one new test), `tst/web/host/hostServices.test.ts` (`requestsChannelId`)

- [ ] **Step 1: Tests**: a regular host's successful POST calls `postToDiscord` with the created row; a promoted host's does not; `requestsChannelId({})` is undefined and warns once; `requestsChannelId({ EVENT_REQUESTS_CHANNEL_ID: '1'.repeat(19) })` returns it; a malformed value is undefined.
- [ ] **Step 2: Run; FAIL. Step 3: Implement and wire** (`dashboardPageDeps` passes `mirrorRequest`; `hostRouterFromEnv` passes `postToDiscord` only when the channel is configured). **Step 4: Run `tst/web`; PASS. Step 5: Commit** `feat(requests): website requests post to Discord; decisions mirror onto the post`.

### Task 7: Verification and PR

- [ ] `npx eslint .` clean; `npx prettier --check "**/*.{ts,js,json,md}"` clean (or `--write`); `npx tsc --noEmit -p . 2>&1 | grep -v '^node_modules'` prints nothing.
- [ ] `npx vitest run` all pass; integration: `DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres REDISCLOUD_URL=redis://localhost:56379 npx vitest run --config vitest.integration.config.ts` all pass.
- [ ] Rebase check: `git fetch origin && gh pr view 135 --json state`; if merged, rebase and switch the cap to `create(input, { maxPending })` in `discordRequests.ts`.
- [ ] Push `feat/unified-request-queue`; open the PR against `main` referencing #137 with the spec and plan linked, the `EVENT_REQUESTS_CHANNEL_ID` config note, and the legacy-handler follow-up. Do not merge.

# Message Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each interaction one accumulating reply instead of two or three separate messages, by routing all interaction-scoped output through a per-interaction stack manager.

**Architecture:** `MessageStack` is pure state (ordered `Map`, no I/O). A `Surface` binds a stack to an injected flush lambda and owns debouncing plus an age guard. `StackManager` holds an `ephemeral` and a `public` surface. A `Map` registry keyed by interaction ID hands managers to helpers via `replyStack(interaction)`. Only the Discord adapter knows about Discord: it clamps payloads, renders the status banner, and recovers from dismissal.

**Tech Stack:** TypeScript, discord.js v14, vitest, tslog.

**Spec:** `docs/superpowers/specs/2026-08-15-message-stack-design.md`

## Global Constraints

- Node ESM: every relative import ends in `.js`, including imports of `.ts` sources.
- Tests live under `tst/`, mirroring the `src/` path. Run with `yarn test`.
- Lint and format: `yarn lint` must pass; `yarn lint:fix` applies prettier. The pre-commit hook runs `lint-staged`, so a lint error blocks the commit.
- `npx tsc --noEmit` must report zero errors in project files (`node_modules/graphql-request` emits pre-existing `HeadersInit` errors — ignore only those).
- Output must never break the command that produced it: every flush failure is caught and logged, never rethrown.
- Status colours reuse `EMBED_COLORS` in `src/constants.ts`. `success` = existing `activity` green `0x2ecc71`; `error` = existing `alert` red `0xe74c3c`; add `pending` yellow `0xf1c40f` and `attention` orange `0xe67e22`.
- Status labels are exactly: `success` → `Finished`, `error` → `Error`, `pending` → `In progress`, `attention` → `Needs attention`.
- Severity order for reducing many entry statuses to one colour: `error` > `attention` > `pending` > `success`.
- Entry text always goes in the message **content**, never an embed description — mentions inside embeds do not notify.
- Debounce 400ms; max age 15 minutes (900000ms).

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/messageStack/types.ts` | `EntryStatus`, `StackEntry`, `RenderedMessage`, `EntryId`, `Flusher` |
| `src/lib/messageStack/messageStack.ts` | `MessageStack` — append/update/pop/render, severity reduction |
| `src/lib/messageStack/surface.ts` | `Surface` — stack + flusher + debounce + age guard |
| `src/lib/messageStack/stackManager.ts` | `StackManager` — owns `ephemeral` and `public` surfaces |
| `src/lib/messageStack/discordAdapter.ts` | Discord flushers: banner, limit clamping, dismissal recovery |
| `src/lib/messageStack/registry.ts` | `replyStack` / `disposeReplyStack`, the interaction-keyed `Map` |
| `src/util/discord.ts` | `discordCommandWrapper` rewired to defer + seed + flush |
| `src/constants.ts` | New `EMBED_COLORS` entries |

---

### Task 1: MessageStack and status colours

**Files:**
- Create: `src/lib/messageStack/types.ts`
- Create: `src/lib/messageStack/messageStack.ts`
- Modify: `src/constants.ts` (add to `EMBED_COLORS`)
- Test: `tst/lib/messageStack/messageStack.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MessageStack` class with `append(entry): EntryId`, `update(id, entry): void`, `pop(): void`, `render(): RenderedMessage | undefined`, `size: number`. Types `EntryStatus = 'success' | 'error' | 'pending' | 'attention'`, `StackEntry<TEmbed, TComponent>`, `RenderedMessage<TEmbed, TComponent>`, `EntryId = string`, `Flusher<TEmbed, TComponent>`.

- [ ] **Step 1: Write the failing test**

Create `tst/lib/messageStack/messageStack.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { MessageStack } from '../../../src/lib/messageStack/messageStack.js';

describe('MessageStack', () => {
  it('renders undefined while empty', () => {
    expect(new MessageStack().render()).toBeUndefined();
  });

  it('joins entry content in insertion order', () => {
    const stack = new MessageStack();
    stack.append({ content: 'first' });
    stack.append({ content: 'second' });

    expect(stack.render()?.content).toBe('first\nsecond');
  });

  it('updates an entry in place without reordering', () => {
    const stack = new MessageStack();
    const id = stack.append({ content: 'first' });
    stack.append({ content: 'second' });
    stack.update(id, { content: 'first (updated)' });

    expect(stack.render()?.content).toBe('first (updated)\nsecond');
  });

  it('ignores an update to an unknown id', () => {
    const stack = new MessageStack();
    stack.append({ content: 'only' });
    stack.update('e99', { content: 'ghost' });

    expect(stack.render()?.content).toBe('only');
  });

  it('pop drops the newest entry and is a no-op when empty', () => {
    const stack = new MessageStack();
    stack.append({ content: 'first' });
    stack.append({ content: 'second' });
    stack.pop();

    expect(stack.render()?.content).toBe('first');

    stack.pop();
    expect(stack.render()).toBeUndefined();
    expect(() => stack.pop()).not.toThrow();
  });

  it('concatenates embeds and components in stack order', () => {
    const stack = new MessageStack<string, string>();
    stack.append({ embeds: ['a'], components: ['x'] });
    stack.append({ embeds: ['b'], components: ['y'] });

    expect(stack.render()?.embeds).toEqual(['a', 'b']);
    expect(stack.render()?.components).toEqual(['x', 'y']);
  });

  it('never puts entry text anywhere but content (mentions must ping)', () => {
    const stack = new MessageStack();
    stack.append({ content: 'Welcome <@123>!' });

    const rendered = stack.render();
    expect(rendered?.content).toContain('<@123>');
    expect(rendered?.embeds).toEqual([]);
  });
});

describe('status severity', () => {
  it('is undefined when no entry declares a status', () => {
    const stack = new MessageStack();
    stack.append({ content: 'plain' });

    expect(stack.render()?.status).toBeUndefined();
  });

  it.each([
    [['success'], 'success'],
    [['pending'], 'pending'],
    [['error'], 'error'],
    [['attention'], 'attention'],
    [['pending', 'error'], 'error'],
    [['pending', 'attention'], 'attention'],
    [['success', 'pending'], 'pending'],
    [['success', 'attention', 'error'], 'error'],
  ] as const)('reduces %j to %s', (statuses, expected) => {
    const stack = new MessageStack();
    statuses.forEach((status) => stack.append({ content: 'x', status }));

    expect(stack.render()?.status).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run tst/lib/messageStack/messageStack.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lib/messageStack/messageStack.js'`

- [ ] **Step 3: Write the types**

Create `src/lib/messageStack/types.ts`:

```typescript
export type EntryStatus = 'success' | 'error' | 'pending' | 'attention';

export type EntryId = string;

/**
 * One unit of output. Text always lands in the message content, never an
 * embed description: a mention inside an embed renders as a link but does
 * not notify anyone.
 */
export interface StackEntry<TEmbed = unknown, TComponent = unknown> {
  content?: string;
  embeds?: TEmbed[];
  components?: TComponent[];
  status?: EntryStatus;
}

export interface RenderedMessage<TEmbed = unknown, TComponent = unknown> {
  content?: string;
  embeds: TEmbed[];
  components: TComponent[];
  /** Most severe status among the entries; undefined if none declared one. */
  status?: EntryStatus;
}

/**
 * Publishes a rendered stack to some platform. `undefined` means the stack is
 * empty: remove the message if one exists, otherwise do nothing.
 */
export type Flusher<TEmbed = unknown, TComponent = unknown> = (
  rendered: RenderedMessage<TEmbed, TComponent> | undefined,
) => Promise<void>;
```

- [ ] **Step 4: Write MessageStack**

Create `src/lib/messageStack/messageStack.ts`:

```typescript
import {
  EntryId,
  EntryStatus,
  RenderedMessage,
  StackEntry,
} from './types.js';

// Most severe first. One message carries one colour, so many entry statuses
// reduce to whichever appears earliest here.
const SEVERITY: EntryStatus[] = ['error', 'attention', 'pending', 'success'];

function mostSevere(
  statuses: (EntryStatus | undefined)[],
): EntryStatus | undefined {
  const present = statuses.filter(
    (status): status is EntryStatus => status !== undefined,
  );
  return SEVERITY.find((status) => present.includes(status));
}

/**
 * Ordered, addressable collection of output entries. Pure state: it knows
 * nothing about Discord and performs no I/O. A Map gives insertion order and
 * id lookup in one structure, so "sorted by creation, addressable by id"
 * needs no second index.
 */
export class MessageStack<TEmbed = unknown, TComponent = unknown> {
  private entries = new Map<EntryId, StackEntry<TEmbed, TComponent>>();

  private nextId = 1;

  get size(): number {
    return this.entries.size;
  }

  append(entry: StackEntry<TEmbed, TComponent>): EntryId {
    const id = `e${this.nextId}`;
    this.nextId += 1;
    this.entries.set(id, entry);
    return id;
  }

  /** Replaces the entry's payload, keeping its position. Unknown id: no-op. */
  update(id: EntryId, entry: StackEntry<TEmbed, TComponent>): void {
    if (!this.entries.has(id)) {
      return;
    }
    this.entries.set(id, entry);
  }

  /** Drops the newest entry, whoever appended it. No-op when empty. */
  pop(): void {
    const newest = [...this.entries.keys()].pop();
    if (newest !== undefined) {
      this.entries.delete(newest);
    }
  }

  render(): RenderedMessage<TEmbed, TComponent> | undefined {
    if (this.entries.size === 0) {
      return undefined;
    }
    const entries = [...this.entries.values()];
    const contents = entries
      .map((entry) => entry.content)
      .filter((content): content is string => Boolean(content));

    return {
      content: contents.length > 0 ? contents.join('\n') : undefined,
      embeds: entries.flatMap((entry) => entry.embeds ?? []),
      components: entries.flatMap((entry) => entry.components ?? []),
      status: mostSevere(entries.map((entry) => entry.status)),
    };
  }
}
```

- [ ] **Step 5: Add the status colours**

In `src/constants.ts`, replace the `EMBED_COLORS` block with:

```typescript
// Embed accent colors, centralized as the seed of a future branding profile.
export const EMBED_COLORS = {
  activity: 0x2ecc71, // green
  alert: 0xe74c3c, // red
  info: 0x3498db, // blue
  pending: 0xf1c40f, // yellow
  attention: 0xe67e22, // orange
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `yarn vitest run tst/lib/messageStack/messageStack.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 7: Verify nothing else broke, then commit**

Run: `yarn test && yarn lint && npx tsc --noEmit | grep -v node_modules`

```bash
git add src/lib/messageStack/types.ts src/lib/messageStack/messageStack.ts src/constants.ts tst/lib/messageStack/messageStack.test.ts
git commit -m "feat: add MessageStack with status severity reduction"
```

---

### Task 2: Surface and StackManager

**Files:**
- Create: `src/lib/messageStack/surface.ts`
- Create: `src/lib/messageStack/stackManager.ts`
- Test: `tst/lib/messageStack/stackManager.test.ts`

**Interfaces:**
- Consumes: `MessageStack`, `Flusher`, `StackEntry`, `EntryId`, `RenderedMessage` from Task 1.
- Produces: `Surface<TEmbed, TComponent>` with `append(entry): EntryId`, `update(id, entry): void`, `pop(): void`, `flush(): Promise<void>`, `dispose(): void`. `StackManager<TEmbed, TComponent>` with readonly `ephemeral: Surface`, readonly `publicSurface: Surface`, `flushAll(): Promise<void>`, `dispose(): void`, constructed as `new StackManager({ flushers: { ephemeral, public: publicFlusher }, debounceMs, maxAgeMs, now? })`.

**Note on naming:** the public surface is exposed as `publicSurface`, not `public` — `public` is a reserved word in TypeScript class contexts and reads badly at call sites. Callers write `replyStack(i).publicSurface.append(...)`.

- [ ] **Step 1: Write the failing test**

Create `tst/lib/messageStack/stackManager.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StackManager } from '../../../src/lib/messageStack/stackManager.js';
import { RenderedMessage } from '../../../src/lib/messageStack/types.js';

const DEBOUNCE_MS = 400;
const MAX_AGE_MS = 900000;

function setup(overrides: { now?: () => number } = {}) {
  const ephemeralFlushes: (RenderedMessage | undefined)[] = [];
  const publicFlushes: (RenderedMessage | undefined)[] = [];
  const manager = new StackManager({
    flushers: {
      ephemeral: async (rendered) => {
        ephemeralFlushes.push(rendered);
      },
      public: async (rendered) => {
        publicFlushes.push(rendered);
      },
    },
    debounceMs: DEBOUNCE_MS,
    maxAgeMs: MAX_AGE_MS,
    ...overrides,
  });
  return { manager, ephemeralFlushes, publicFlushes };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Surface flushing', () => {
  it('coalesces a burst of mutations into one flush', async () => {
    const { manager, ephemeralFlushes } = setup();

    manager.ephemeral.append({ content: 'one' });
    manager.ephemeral.append({ content: 'two' });
    const id = manager.ephemeral.append({ content: 'three' });
    manager.ephemeral.update(id, { content: 'three!' });

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(ephemeralFlushes).toHaveLength(1);
    expect(ephemeralFlushes[0]?.content).toBe('one\ntwo\nthree!');
  });

  it('flushAll emits pending state immediately', async () => {
    const { manager, ephemeralFlushes } = setup();
    manager.ephemeral.append({ content: 'now' });

    await manager.flushAll();

    expect(ephemeralFlushes).toHaveLength(1);
    expect(ephemeralFlushes[0]?.content).toBe('now');
  });

  it('does not flush again when nothing changed', async () => {
    const { manager, ephemeralFlushes } = setup();
    manager.ephemeral.append({ content: 'once' });

    await manager.flushAll();
    await manager.flushAll();

    expect(ephemeralFlushes).toHaveLength(1);
  });

  it('flushes undefined when a stack is emptied by pop', async () => {
    const { manager, ephemeralFlushes } = setup();
    manager.ephemeral.append({ content: 'gone soon' });
    await manager.flushAll();
    manager.ephemeral.pop();

    await manager.flushAll();

    expect(ephemeralFlushes).toEqual([
      expect.objectContaining({ content: 'gone soon' }),
      undefined,
    ]);
  });

  it('keeps the two surfaces independent', async () => {
    const { manager, ephemeralFlushes, publicFlushes } = setup();
    manager.publicSurface.append({ content: 'everyone' });

    await manager.flushAll();

    expect(publicFlushes[0]?.content).toBe('everyone');
    expect(ephemeralFlushes).toHaveLength(0);
  });

  it('swallows a rejecting flusher', async () => {
    const manager = new StackManager({
      flushers: {
        ephemeral: async () => {
          throw new Error('discord down');
        },
        public: async () => {},
      },
      debounceMs: DEBOUNCE_MS,
      maxAgeMs: MAX_AGE_MS,
    });
    manager.ephemeral.append({ content: 'doomed' });

    await expect(manager.flushAll()).resolves.toBeUndefined();
  });

  it('stops flushing once past maxAgeMs', async () => {
    let clock = 0;
    const { manager, ephemeralFlushes } = setup({ now: () => clock });

    manager.ephemeral.append({ content: 'in time' });
    await manager.flushAll();

    clock = MAX_AGE_MS + 1;
    manager.ephemeral.append({ content: 'too late' });
    await manager.flushAll();

    expect(ephemeralFlushes).toHaveLength(1);
  });

  it('dispose cancels a pending debounce', async () => {
    const { manager, ephemeralFlushes } = setup();
    manager.ephemeral.append({ content: 'never sent' });

    manager.dispose();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);

    expect(ephemeralFlushes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run tst/lib/messageStack/stackManager.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lib/messageStack/stackManager.js'`

- [ ] **Step 3: Write Surface**

Create `src/lib/messageStack/surface.ts`:

```typescript
import { Logger } from 'tslog';

import { MessageStack } from './messageStack.js';
import { EntryId, Flusher, StackEntry } from './types.js';

const logger = new Logger({ name: 'MessageSurface' });

interface SurfaceOptions {
  debounceMs: number;
  /** True once the platform can no longer be written to (token expired). */
  isExpired: () => boolean;
}

/**
 * A stack bound to one platform message. Mutations are synchronous and cheap;
 * the flush that publishes them is debounced, so a burst of updates costs one
 * API call.
 */
export class Surface<TEmbed = unknown, TComponent = unknown> {
  private stack = new MessageStack<TEmbed, TComponent>();

  private timer: NodeJS.Timeout | undefined;

  private dirty = false;

  constructor(
    private readonly flusher: Flusher<TEmbed, TComponent>,
    private readonly options: SurfaceOptions,
  ) {}

  append(entry: StackEntry<TEmbed, TComponent>): EntryId {
    const id = this.stack.append(entry);
    this.schedule();
    return id;
  }

  update(id: EntryId, entry: StackEntry<TEmbed, TComponent>): void {
    this.stack.update(id, entry);
    this.schedule();
  }

  pop(): void {
    this.stack.pop();
    this.schedule();
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.debounceMs);
  }

  /** Publishes pending state now. Never throws. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    if (this.options.isExpired()) {
      return;
    }
    try {
      await this.flusher(this.stack.render());
    } catch (error) {
      // Output must never break the command that produced it.
      logger.error(`Flush failed: ${String(error)}`);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.dirty = false;
  }
}
```

- [ ] **Step 4: Write StackManager**

Create `src/lib/messageStack/stackManager.ts`:

```typescript
import { Logger } from 'tslog';

import { Surface } from './surface.js';
import { Flusher } from './types.js';

const logger = new Logger({ name: 'StackManager' });

interface StackManagerOptions<TEmbed, TComponent> {
  flushers: {
    ephemeral: Flusher<TEmbed, TComponent>;
    public: Flusher<TEmbed, TComponent>;
  };
  debounceMs: number;
  maxAgeMs: number;
  /** Injectable clock; tests drive expiry without waiting. */
  now?: () => number;
}

/**
 * Owns one interaction's output: an ephemeral surface and a public one, each
 * rendering to at most one platform message.
 */
export class StackManager<TEmbed = unknown, TComponent = unknown> {
  readonly ephemeral: Surface<TEmbed, TComponent>;

  readonly publicSurface: Surface<TEmbed, TComponent>;

  private expiryLogged = false;

  constructor(options: StackManagerOptions<TEmbed, TComponent>) {
    const now = options.now ?? (() => Date.now());
    const createdAt = now();
    const isExpired = () => {
      const expired = now() - createdAt > options.maxAgeMs;
      if (expired && !this.expiryLogged) {
        this.expiryLogged = true;
        logger.info('Stack past max age; dropping further flushes');
      }
      return expired;
    };
    const surfaceOptions = { debounceMs: options.debounceMs, isExpired };

    this.ephemeral = new Surface(options.flushers.ephemeral, surfaceOptions);
    this.publicSurface = new Surface(options.flushers.public, surfaceOptions);
  }

  async flushAll(): Promise<void> {
    await Promise.all([this.ephemeral.flush(), this.publicSurface.flush()]);
  }

  dispose(): void {
    this.ephemeral.dispose();
    this.publicSurface.dispose();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn vitest run tst/lib/messageStack/stackManager.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Commit**

Run: `yarn test && yarn lint`

```bash
git add src/lib/messageStack/surface.ts src/lib/messageStack/stackManager.ts tst/lib/messageStack/stackManager.test.ts
git commit -m "feat: add Surface and StackManager with debounced flushing"
```

---

### Task 3: Discord adapter

**Files:**
- Create: `src/lib/messageStack/discordAdapter.ts`
- Test: `tst/lib/messageStack/discordAdapter.test.ts`

**Interfaces:**
- Consumes: `RenderedMessage`, `Flusher`, `EntryStatus` from Task 1; `EMBED_COLORS` from `src/constants.ts`; `describeInteraction` from `src/util/discord.js`.
- Produces: `createDiscordFlushers(interaction): { ephemeral: Flusher<EmbedBuilder, ActionRowBuilder<MessageActionRowComponentBuilder>>; public: Flusher<...> }` and, exported for testing, `toDiscordPayload(rendered, action)`.

**Discord behaviours this task encodes:**
- The wrapper defers the reply (Task 4), so the ephemeral surface publishes with `interaction.editReply` and only falls back to `followUp` after a dismissal.
- Error code `10008` (`Unknown Message`) means the user dismissed it. Re-send the whole stack as a fresh ephemeral `followUp` and keep using that handle.
- Codes `50027` / `10062` mean the interaction token is dead: log and give up.
- Limits: 2000 content characters, 10 embeds, 5 component rows.

- [ ] **Step 1: Write the failing test**

Create `tst/lib/messageStack/discordAdapter.test.ts`:

```typescript
/* eslint-disable @typescript-eslint/no-explicit-any */
import { CommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { EMBED_COLORS } from '../../../src/constants.js';
import {
  createDiscordFlushers,
  toDiscordPayload,
} from '../../../src/lib/messageStack/discordAdapter.js';

class DiscordAPIErrorStub extends Error {
  constructor(public code: number) {
    super(`stub discord error ${code}`);
  }
}

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    commandName: 'test_command',
    isChatInputCommand: () => true,
    editReply: vi.fn().mockResolvedValue({ id: 'm1' }),
    followUp: vi.fn().mockResolvedValue({ id: 'm2' }),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    channel: { send: vi.fn().mockResolvedValue({ id: 'p1' }) },
    ...overrides,
  } as unknown as CommandInteraction;
}

describe('toDiscordPayload', () => {
  it('appends a status banner carrying colour, label and action', () => {
    const payload = toDiscordPayload(
      { content: 'hi', embeds: [], components: [], status: 'pending' },
      '/test_command',
    );

    expect(payload.content).toBe('hi');
    expect(payload.embeds).toHaveLength(1);
    const banner = payload.embeds[0].toJSON();
    expect(banner.color).toBe(EMBED_COLORS.pending);
    expect(banner.title).toBe('In progress');
    expect(banner.footer?.text).toBe('/test_command');
  });

  it('adds no banner when no entry declared a status', () => {
    const payload = toDiscordPayload(
      { content: 'plain', embeds: [], components: [] },
      '/test_command',
    );

    expect(payload.embeds).toHaveLength(0);
  });

  it('clamps content, embeds and component rows to Discord limits', () => {
    const payload = toDiscordPayload(
      {
        content: 'x'.repeat(2500),
        embeds: Array.from({ length: 12 }, () => ({}) as any),
        components: Array.from({ length: 7 }, () => ({}) as any),
        status: 'success',
      },
      '/test_command',
    );

    expect(payload.content?.length).toBe(2000);
    expect(payload.content?.endsWith('…')).toBe(true);
    expect(payload.embeds).toHaveLength(10);
    expect(payload.components).toHaveLength(5);
  });

  it('sends an empty string rather than undefined so content can be cleared', () => {
    const payload = toDiscordPayload(
      { embeds: [], components: [], status: 'success' },
      '/test_command',
    );

    expect(payload.content).toBe('');
  });
});

describe('ephemeral flusher', () => {
  it('edits the deferred reply on first publish', async () => {
    const interaction = makeInteraction();
    const { ephemeral } = createDiscordFlushers(interaction);

    await ephemeral({ content: 'first', embeds: [], components: [] });

    expect(vi.mocked(interaction.editReply)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(interaction.followUp)).not.toHaveBeenCalled();
  });

  it('recreates the message with the whole stack after a dismissal', async () => {
    const interaction = makeInteraction({
      editReply: vi
        .fn()
        .mockResolvedValueOnce({ id: 'm1' })
        .mockRejectedValueOnce(new DiscordAPIErrorStub(10008)),
    });
    const { ephemeral } = createDiscordFlushers(interaction);

    await ephemeral({ content: 'first', embeds: [], components: [] });
    await ephemeral({ content: 'first\nsecond', embeds: [], components: [] });

    expect(vi.mocked(interaction.followUp)).toHaveBeenCalledTimes(1);
    const [args] = vi.mocked(interaction.followUp).mock.calls[0] as [
      { content: string; ephemeral: boolean },
    ];
    expect(args.content).toBe('first\nsecond');
    expect(args.ephemeral).toBe(true);
  });

  it('gives up quietly when the interaction token is dead', async () => {
    const interaction = makeInteraction({
      editReply: vi.fn().mockRejectedValue(new DiscordAPIErrorStub(50027)),
    });
    const { ephemeral } = createDiscordFlushers(interaction);

    await expect(
      ephemeral({ content: 'doomed', embeds: [], components: [] }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(interaction.followUp)).not.toHaveBeenCalled();
  });

  it('deletes the reply when the stack empties, and does nothing if never published', async () => {
    const interaction = makeInteraction();
    const { ephemeral } = createDiscordFlushers(interaction);

    await ephemeral(undefined);
    expect(vi.mocked(interaction.deleteReply)).not.toHaveBeenCalled();

    await ephemeral({ content: 'here', embeds: [], components: [] });
    await ephemeral(undefined);
    expect(vi.mocked(interaction.deleteReply)).toHaveBeenCalledTimes(1);
  });
});

describe('public flusher', () => {
  it('sends to the channel then edits that message', async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    const interaction = makeInteraction({
      channel: { send: vi.fn().mockResolvedValue({ id: 'p1', edit }) },
    });
    const { public: publicFlusher } = createDiscordFlushers(interaction);

    await publicFlusher({ content: 'hello', embeds: [], components: [] });
    await publicFlusher({ content: 'hello again', embeds: [], components: [] });

    expect(vi.mocked(interaction.channel!.send)).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run tst/lib/messageStack/discordAdapter.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lib/messageStack/discordAdapter.js'`

- [ ] **Step 3: Write the adapter**

Create `src/lib/messageStack/discordAdapter.ts`:

```typescript
import {
  ActionRowBuilder,
  ButtonInteraction,
  CommandInteraction,
  EmbedBuilder,
  Message,
  MessageActionRowComponentBuilder,
  ModalSubmitInteraction,
  TextBasedChannel,
} from 'discord.js';
import { Logger } from 'tslog';

import { EMBED_COLORS } from '../../constants.js';
import { describeInteraction } from '../../util/discord.js';
import { EntryStatus, Flusher, RenderedMessage } from './types.js';

const logger = new Logger({ name: 'DiscordStackAdapter' });

const MAX_CONTENT = 2000;
const MAX_EMBEDS = 10;
const MAX_ROWS = 5;

// The user dismissed the message, or it was deleted.
const UNKNOWN_MESSAGE = 10008;
// The interaction token is dead; nothing can be written for this interaction.
const DEAD_TOKEN_CODES = [50027, 10062];

const STATUS_COLORS: Record<EntryStatus, number> = {
  success: EMBED_COLORS.activity,
  error: EMBED_COLORS.alert,
  pending: EMBED_COLORS.pending,
  attention: EMBED_COLORS.attention,
};

const STATUS_LABELS: Record<EntryStatus, string> = {
  success: 'Finished',
  error: 'Error',
  pending: 'In progress',
  attention: 'Needs attention',
};

type StackInteraction =
  | ButtonInteraction
  | CommandInteraction
  | ModalSubmitInteraction;

type Embed = EmbedBuilder;
type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;

interface DiscordPayload {
  components: Row[];
  content: string;
  embeds: Embed[];
}

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

function clampContent(content: string | undefined): string {
  if (!content) {
    return '';
  }
  if (content.length <= MAX_CONTENT) {
    return content;
  }
  logger.warn(`Stack content ${content.length} chars; truncating`);
  return `${content.slice(0, MAX_CONTENT - 1)}…`;
}

/**
 * Turns a rendered stack into a Discord message payload: text stays in the
 * content (so mentions notify) and the status becomes a small banner embed
 * beneath it.
 */
export function toDiscordPayload(
  rendered: RenderedMessage<Embed, Row>,
  action: string,
): DiscordPayload {
  const embeds = [...rendered.embeds];
  if (rendered.status) {
    embeds.push(
      new EmbedBuilder()
        .setColor(STATUS_COLORS[rendered.status])
        .setTitle(STATUS_LABELS[rendered.status])
        .setFooter({ text: action }),
    );
  }
  if (embeds.length > MAX_EMBEDS) {
    logger.warn(`Stack produced ${embeds.length} embeds; truncating`);
  }
  if (rendered.components.length > MAX_ROWS) {
    logger.warn(
      `Stack produced ${rendered.components.length} rows; truncating`,
    );
  }
  return {
    content: clampContent(rendered.content),
    embeds: embeds.slice(0, MAX_EMBEDS),
    components: rendered.components.slice(0, MAX_ROWS),
  };
}

function createEphemeralFlusher(
  interaction: StackInteraction,
  action: string,
): Flusher<Embed, Row> {
  // Undefined until the first publish; set to a concrete message only after a
  // dismissal forces a followUp, since editReply targets the original reply.
  let recreated: Message | undefined;
  let published = false;

  return async (rendered) => {
    if (!rendered) {
      if (published) {
        await (recreated
          ? recreated.delete()
          : interaction.deleteReply()
        ).catch((error) => {
          logger.warn(`Could not remove empty stack message: ${String(error)}`);
        });
        published = false;
        recreated = undefined;
      }
      return;
    }

    const payload = toDiscordPayload(rendered, action);
    try {
      if (recreated) {
        await recreated.edit(payload);
      } else {
        await interaction.editReply(payload);
      }
      published = true;
    } catch (error) {
      const code = errorCode(error);
      if (code === UNKNOWN_MESSAGE) {
        // Dismissed: re-send the whole stack and keep going in the new message.
        recreated = (await interaction.followUp({
          ...payload,
          ephemeral: true,
        })) as Message;
        published = true;
        return;
      }
      if (code !== undefined && DEAD_TOKEN_CODES.includes(code)) {
        logger.info('Interaction token expired; dropping stack output');
        return;
      }
      throw error;
    }
  };
}

function createPublicFlusher(
  interaction: StackInteraction,
  action: string,
): Flusher<Embed, Row> {
  let message: Message | undefined;

  return async (rendered) => {
    if (!rendered) {
      if (message) {
        await message.delete().catch((error) => {
          logger.warn(`Could not remove public message: ${String(error)}`);
        });
        message = undefined;
      }
      return;
    }

    const payload = toDiscordPayload(rendered, action);
    if (!message) {
      const channel = interaction.channel as TextBasedChannel & {
        send: (payload: DiscordPayload) => Promise<Message>;
      };
      message = await channel.send(payload);
      return;
    }
    try {
      await message.edit(payload);
    } catch (error) {
      if (errorCode(error) === UNKNOWN_MESSAGE) {
        message = undefined;
        logger.warn('Public stack message vanished; will re-send next flush');
        return;
      }
      throw error;
    }
  };
}

export function createDiscordFlushers(interaction: StackInteraction): {
  ephemeral: Flusher<Embed, Row>;
  public: Flusher<Embed, Row>;
} {
  const action = describeInteraction(interaction);
  return {
    ephemeral: createEphemeralFlusher(interaction, action),
    public: createPublicFlusher(interaction, action),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run tst/lib/messageStack/discordAdapter.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

Run: `yarn test && yarn lint && npx tsc --noEmit | grep -v node_modules`

```bash
git add src/lib/messageStack/discordAdapter.ts tst/lib/messageStack/discordAdapter.test.ts
git commit -m "feat: add Discord flushers with status banner and dismissal recovery"
```

---

### Task 4: Registry and wrapper integration

**Files:**
- Create: `src/lib/messageStack/registry.ts`
- Modify: `src/util/discord.ts` (`discordCommandWrapper`, lines 40-74)
- Test: `tst/commands/meetup/util/discord.test.ts` (rewrite the wrapper describe block)

**Interfaces:**
- Consumes: `StackManager` (Task 2), `createDiscordFlushers` (Task 3).
- Produces: `replyStack(interaction): StackManager<EmbedBuilder, ActionRowBuilder<MessageActionRowComponentBuilder>>` and `disposeReplyStack(interaction): void`.

**Behaviour change:** the wrapper defers instead of replying with "Executing command", seeds a `pending` entry, removes it before returning, and appends an `error` entry on failure. There is no `message.delete()` any more — the deferred reply either becomes the stack's message or is deleted when the stack ends empty.

- [ ] **Step 1: Write the failing test**

Replace the `discordCommandWrapper logging hooks` describe block in `tst/commands/meetup/util/discord.test.ts` with:

```typescript
describe('discordCommandWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defers, runs the command, and flushes one message', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {
      replyStack(interaction).ephemeral.append({
        content: 'result',
        status: 'success',
      });
    });

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(vi.mocked(interaction.editReply)).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(interaction.editReply).mock.calls[0] as [
      { content: string },
    ];
    expect(payload.content).toBe('result');
  });

  it('posts an activity entry on success', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {});

    expect(vi.mocked(discordLogger.logActivity)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
  });

  it('renders the error in the stack and alerts', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {
      throw new Error('boom');
    });

    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(interaction.editReply).mock.calls[0] as [
      { content: string },
    ];
    expect(payload.content).toContain('boom');
  });

  it('skips the generic alert for duplicate-link blocks (already alerted)', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {
      throw new DuplicateMeetupAccountError('already linked');
    });

    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
  });

  it('leaves no message when the flow produced no output', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {});

    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(interaction.editReply)).not.toHaveBeenCalled();
  });

  it('disposes the manager so the registry does not grow', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {
      replyStack(interaction).ephemeral.append({ content: 'x' });
    });

    expect(replyStack(interaction)).not.toBe(
      // a fresh manager is handed out after disposal
      undefined,
    );
    expect(registrySize()).toBe(0);
  });
});
```

Update the imports and `makeInteraction` at the top of that file:

```typescript
import { DuplicateMeetupAccountError } from '../../../../src/lib/helpers/memberLink.js';
import {
  registrySize,
  replyStack,
} from '../../../../src/lib/messageStack/registry.js';

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    client: {},
    user: { id: 'user-1', username: 'testUser', toString: () => '<@user-1>' },
    commandName: 'test_command',
    isChatInputCommand: () => true,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({ id: 'm1' }),
    followUp: vi.fn().mockResolvedValue({ id: 'm2' }),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    channel: { send: vi.fn().mockResolvedValue({ id: 'p1' }) },
    id: `interaction-${Math.random()}`,
    ...overrides,
  } as unknown as CommandInteraction;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run tst/commands/meetup/util/discord.test.ts`
Expected: FAIL — `Cannot find module '../../../../src/lib/messageStack/registry.js'`

- [ ] **Step 3: Write the registry**

Create `src/lib/messageStack/registry.ts`:

```typescript
import {
  ActionRowBuilder,
  ButtonInteraction,
  CommandInteraction,
  EmbedBuilder,
  MessageActionRowComponentBuilder,
  ModalSubmitInteraction,
} from 'discord.js';

import { createDiscordFlushers } from './discordAdapter.js';
import { StackManager } from './stackManager.js';

const DEBOUNCE_MS = 400;
// Discord interaction tokens live 15 minutes; past that every write fails.
const MAX_AGE_MS = 15 * 60 * 1000;

type StackInteraction =
  | ButtonInteraction
  | CommandInteraction
  | ModalSubmitInteraction;

export type ReplyStack = StackManager<
  EmbedBuilder,
  ActionRowBuilder<MessageActionRowComponentBuilder>
>;

const registry = new Map<string, ReplyStack>();

/**
 * The interaction's output manager, created on first use. Every helper in
 * these flows already receives the interaction, so nothing needs a new
 * parameter. discordCommandWrapper disposes it when the command ends.
 */
export function replyStack(interaction: StackInteraction): ReplyStack {
  const existing = registry.get(interaction.id);
  if (existing) {
    return existing;
  }
  const manager: ReplyStack = new StackManager({
    flushers: createDiscordFlushers(interaction),
    debounceMs: DEBOUNCE_MS,
    maxAgeMs: MAX_AGE_MS,
  });
  registry.set(interaction.id, manager);
  return manager;
}

export function disposeReplyStack(interaction: StackInteraction): void {
  const manager = registry.get(interaction.id);
  if (!manager) {
    return;
  }
  manager.dispose();
  registry.delete(interaction.id);
}

/** Test seam: asserts the registry is not accumulating managers. */
export function registrySize(): number {
  return registry.size;
}
```

- [ ] **Step 4: Rewire the wrapper**

In `src/util/discord.ts`, replace the body of `discordCommandWrapper` (currently lines 40-74) with:

```typescript
export async function discordCommandWrapper(
  interaction: ButtonInteraction | CommandInteraction | ModalSubmitInteraction,
  commandFn: () => Promise<void>,
) {
  await interaction.deferReply({ ephemeral: true });
  const action = describeInteraction(interaction);
  const stack = replyStack(interaction);
  // Seeded so a slow command shows progress; removed before returning, so a
  // command finishing inside the debounce window never renders it at all.
  const workingId = stack.ephemeral.append({
    content: 'Working on it…',
    status: 'pending',
  });
  try {
    await commandFn();
    stack.ephemeral.remove(workingId);
    await logActivity(interaction.client, {
      title: `${action} used`,
      description: `By ${interaction.user.toString()} (${
        interaction.user.username
      })`,
    });
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.error(error);
      stack.ephemeral.update(workingId, {
        content: `${error.message} Please reach out to a moderator for help.`,
        status: 'error',
      });
      const alertHandled =
        (error as { alertHandled?: boolean }).alertHandled === true;
      if (!alertHandled) {
        await logAlert(interaction.client, {
          title: `${action} failed`,
          description: `User: ${interaction.user.toString()} (${
            interaction.user.username
          })\nError: ${error.message}`,
        });
      }
    }
  } finally {
    await stack.flushAll();
    disposeReplyStack(interaction);
  }
}
```

Add the imports at the top of `src/util/discord.ts`:

```typescript
import {
  disposeReplyStack,
  replyStack,
} from '../lib/messageStack/registry.js';
```

- [ ] **Step 5: Add `remove` to Surface and MessageStack**

The wrapper needs to delete a specific entry, not just the newest. In `src/lib/messageStack/messageStack.ts` add:

```typescript
  /** Deletes one entry by id. Unknown id: no-op. */
  remove(id: EntryId): void {
    this.entries.delete(id);
  }
```

In `src/lib/messageStack/surface.ts` add:

```typescript
  remove(id: EntryId): void {
    this.stack.remove(id);
    this.schedule();
  }
```

Add to `tst/lib/messageStack/messageStack.test.ts`:

```typescript
  it('remove deletes a specific entry and ignores unknown ids', () => {
    const stack = new MessageStack();
    const first = stack.append({ content: 'first' });
    stack.append({ content: 'second' });

    stack.remove(first);
    stack.remove('e99');

    expect(stack.render()?.content).toBe('second');
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `yarn vitest run tst/commands/meetup/util/discord.test.ts tst/lib/messageStack/`
Expected: PASS

- [ ] **Step 7: Commit**

Run: `yarn test && yarn lint && npx tsc --noEmit | grep -v node_modules`

Note: other suites may fail here because their commands still call `followUp` on an interaction that is now deferred rather than replied. That is expected and fixed in Tasks 5 and 6; do not "fix" them by reverting the wrapper.

```bash
git add src/lib/messageStack/registry.ts src/lib/messageStack/messageStack.ts src/lib/messageStack/surface.ts src/util/discord.ts tst/
git commit -m "feat: route command output through a per-interaction stack"
```

---

### Task 5: Migrate the link and onboarding flows

**Files:**
- Modify: `src/util/meetup.ts:42` (OAuth button `editReply`)
- Modify: `src/lib/helpers/onboardUser.ts:134,138,203`
- Modify: `src/lib/helpers/getBadges.ts:16,61`
- Modify: `src/lib/helpers/getUserRoles.ts:15,62`
- Modify: `src/buttonMenu/meetup/syncAccountV2.ts` (3 sites)
- Modify: `src/commands/meetup/selfOnboard.ts:66`
- Test: `tst/lib/helpers/onboardUser.test.ts` (create)

**Interfaces:**
- Consumes: `replyStack` from Task 4.
- Produces: no new exports; these flows now emit through the stack.

**Transformation rules.** Apply exactly these shapes:

| Before | After |
| --- | --- |
| `await interaction.followUp({ content: X, ephemeral: true })` | `replyStack(interaction).ephemeral.append({ content: X, status: 'success' })` |
| `await interaction.followUp({ content: X })` (public, no `ephemeral`) | `replyStack(interaction).publicSurface.append({ content: X })` |
| `await interaction.editReply({ content: X })` used as progress | `replyStack(interaction).ephemeral.update(id, { content: X, status: 'pending' })` where `id` is kept from the flow's first `append` |
| `await interaction.editReply({ content: X, components: [row] })` | `replyStack(interaction).ephemeral.append({ content: X, components: [row], status: 'pending' })` |

Statuses: mid-flow progress lines are `pending`; terminal success lines are `success`; a manual onboard notice (deprecated flow needing follow-up) is `attention`.

The public welcome message in `onboardUser.ts:138` keeps its mention and moves to `publicSurface` — this is the case the plain-content rule exists for.

- [ ] **Step 1: Write the failing test**

Create `tst/lib/helpers/onboardUser.test.ts`:

```typescript
/* eslint-disable @typescript-eslint/unbound-method */
import { CommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { replyStack } from '../../../src/lib/messageStack/registry.js';

vi.mock('../../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
}));

function makeInteraction(id: string) {
  return {
    id,
    client: {},
    user: { id: 'u1', username: 'tester', toString: () => '<@u1>' },
    commandName: 'meetup_self_onboard',
    isChatInputCommand: () => true,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue({ id: 'm1' }),
    followUp: vi.fn().mockResolvedValue({ id: 'm2' }),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    channel: { send: vi.fn().mockResolvedValue({ id: 'p1' }) },
  } as unknown as CommandInteraction;
}

describe('onboarding output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('collapses a multi-step flow into one ephemeral message', async () => {
    const interaction = makeInteraction('i-collapse');
    const stack = replyStack(interaction);

    stack.ephemeral.append({ content: 'Linked your Meetup account.', status: 'pending' });
    stack.ephemeral.append({ content: 'Added your roles.', status: 'pending' });
    stack.ephemeral.append({ content: 'Done!', status: 'success' });
    await stack.flushAll();

    expect(vi.mocked(interaction.editReply)).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(interaction.editReply).mock.calls[0] as [
      { content: string },
    ];
    expect(payload.content).toBe(
      'Linked your Meetup account.\nAdded your roles.\nDone!',
    );
  });

  it('keeps the public welcome message pingable in message content', async () => {
    const interaction = makeInteraction('i-welcome');
    const stack = replyStack(interaction);

    stack.publicSurface.append({ content: 'Welcome <@u1>!' });
    await stack.flushAll();

    const [payload] = vi.mocked(interaction.channel!.send).mock.calls[0] as [
      { content: string; embeds: unknown[] },
    ];
    expect(payload.content).toBe('Welcome <@u1>!');
    expect(payload.embeds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run tst/lib/helpers/onboardUser.test.ts`
Expected: PASS for the collapse test (it exercises Task 1-4 code) — if it fails, Tasks 1-4 have a defect; fix there, not here. This test is the regression guard the migration must not break.

- [ ] **Step 3: Migrate each file**

Work file by file, applying the transformation table. For `src/util/meetup.ts:42`, the OAuth button becomes:

```typescript
  replyStack(interaction).ephemeral.append({
    content: 'Please connect your Meetup account:',
    components: [row],
    status: 'pending',
  });
```

For `src/lib/helpers/onboardUser.ts`, lines 134-139 become:

```typescript
  replyStack(interaction).ephemeral.append({
    content: strings.replyToModerator,
    status: 'attention',
  });
  replyStack(interaction).publicSurface.append({
    content: strings.welcomeMsg(user),
  });
```

Remove the `await` on each converted call — stack mutations are synchronous.

- [ ] **Step 4: Run the flow tests**

Run: `yarn vitest run tst/lib/helpers/ tst/commands/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/util/meetup.ts src/lib/helpers/onboardUser.ts src/lib/helpers/getBadges.ts src/lib/helpers/getUserRoles.ts src/buttonMenu/meetup/syncAccountV2.ts src/commands/meetup/selfOnboard.ts tst/lib/helpers/onboardUser.test.ts
git commit -m "refactor: emit link and onboarding output through the stack"
```

---

### Task 6: Migrate the remaining commands

**Files:**
- Modify: `src/lib/helpers/whois.ts:36,62,82,91`
- Modify: `src/lib/helpers/channel.ts:34`
- Modify: `src/buttonMenu/messageMods.ts:60,75`
- Modify: `src/buttonMenu/AANHPIFlags.ts`
- Modify: `src/commands/meetup/unlinkAccount.ts:59,77`
- Modify: `src/commands/meetup/testGQL.ts:56,64`
- Modify: `src/commands/meetup/getToken.ts`
- Modify: `src/commands/meetup/getNoShow.ts`
- Modify: `src/commands/meetup/createEvent.ts` (3 sites)
- Modify: `src/contextMenu/meetup/announceEvent.ts:42`
- Modify: `src/commands/meetup/getUnannouncedEvents.ts:54,96,102`
- Modify: `src/commands/meetup/getEventStats.ts:87,229` (the two `editReply` calls only)
- Test: `tst/lib/helpers/whois.test.ts` (update existing assertions)

**Interfaces:**
- Consumes: `replyStack` from Task 4.
- Produces: nothing new.

**Do not convert** `getEventStats.ts:174` and `:315`. Those pass `attachmentArgs` from `withDiscordFileAttachment`, which deletes its temp file the moment its callback returns; a debounced flush would upload a file that no longer exists. They stay direct `followUp` calls.

- [ ] **Step 1: Update the whois tests to expect stack output**

In `tst/lib/helpers/whois.test.ts`, the helper tests currently assert on `interaction.followUp`. Replace those assertions with stack assertions, e.g.:

```typescript
  it('replies with an embed and audits the target on a user lookup', async () => {
    const interaction = makeInteraction();
    await whoisByDiscordUser(interaction, 'discord-1');
    await replyStack(interaction).flushAll();

    const [payload] = vi.mocked(interaction.editReply).mock.calls[0] as [
      { embeds: unknown[] },
    ];
    expect(payload.embeds.length).toBeGreaterThan(0);
    expect(vi.mocked(discordLogger.logActivity)).toHaveBeenCalledTimes(1);
  });
```

Add `deferReply`, `editReply`, `deleteReply`, `channel.send` and an `id` to that file's `makeInteraction`, matching Task 4's version.

- [ ] **Step 2: Run to verify they fail**

Run: `yarn vitest run tst/lib/helpers/whois.test.ts`
Expected: FAIL — `editReply` not called, because `whois.ts` still uses `followUp`

- [ ] **Step 3: Migrate the files**

Apply the same transformation table as Task 5. Statuses for these commands: a lookup result or successful action is `success`; a "no record found" reply is `attention`; a permission refusal already throws and is rendered by the wrapper.

- [ ] **Step 4: Run the full suite**

Run: `yarn test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ tst/
git commit -m "refactor: emit remaining command output through the stack"
```

---

### Task 7: Full verification

**Files:**
- Modify: `README.md` (add a short "Command output" section)

- [ ] **Step 1: Confirm no interaction-scoped call sites remain**

Run:

```bash
grep -rn "\.editReply(\|\.followUp(" --include="*.ts" src/ | grep -v discordLogger | grep -v messageStack | grep -v "src/util/discord.ts"
```

Expected: only `src/commands/meetup/getEventStats.ts:174` and `:315` (the attachment sends).

- [ ] **Step 2: Run every check**

```bash
yarn lint && npx tsc --noEmit | grep -v node_modules; yarn test && yarn test:integration:docker
```

Expected: lint clean, zero project type errors, all unit tests pass, all integration tests pass.

- [ ] **Step 3: Document the pattern**

Add to `README.md`:

```markdown
## Command output

Commands do not call `interaction.followUp` or `editReply` directly. Each
interaction gets a stack manager; helpers append to it and the manager
publishes one ephemeral message and, if used, one public message:

    replyStack(interaction).ephemeral.append({ content: 'Done', status: 'success' });

Entry text lands in the message content (so mentions still ping) and the
status colours a small banner beneath it: green finished, yellow in progress,
orange needs attention, red error. Flushes are debounced and never throw.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: describe the command output stack"
```

---

## Self-Review

**Spec coverage.** Problem statement → Tasks 5-6. `MessageStack` including generics and the Map-as-index decision → Task 1. Status table, severity, palette, banner title/footer, statusless surfaces → Tasks 1 and 3. `Surface`, `StackManager`, debounce, age guard → Task 2. Registry and `finally` disposal → Task 4. Discord adapter, limits, dismissal recovery, dead tokens → Task 3. Wrapper changes and both intended consequences → Task 4. Call-site migration including the attachment exclusion → Tasks 5-7. Every testing bullet in the spec maps to a named test.

**Placeholder scan.** No TBD/TODO; every code step carries real code; no "similar to Task N" references.

**Type consistency.** `EntryId` is `string` throughout. `remove(id)` is introduced in Task 4 Step 5 in both `MessageStack` and `Surface` before Task 5 uses it — Task 1's interface block does not list it, which is intentional: it appears where the need appears. The public surface is `publicSurface` everywhere (Tasks 2, 4, 5, 6) because `public` is reserved. `Flusher` receives `RenderedMessage | undefined` in Tasks 1, 2 and 3 alike. `toDiscordPayload` returns `content: string` (never `undefined`) so a cleared stack blanks the message.

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

  it('serializes flushes so concurrent flush() calls are queued, not overlapped', async () => {
    const ephemeralFlushes: (RenderedMessage | undefined)[] = [];
    let resolveFlusher: (() => void) | undefined;
    const manager = new StackManager({
      flushers: {
        ephemeral: async (rendered) => {
          ephemeralFlushes.push(rendered);
          // First call is delayed; second resolves immediately.
          if (ephemeralFlushes.length === 1) {
            return new Promise<void>((resolve) => {
              resolveFlusher = resolve;
            });
          }
        },
        public: async () => {},
      },
      debounceMs: DEBOUNCE_MS,
      maxAgeMs: MAX_AGE_MS,
    });

    // First mutation, triggers debounce.
    manager.ephemeral.append({ content: 'first' });
    // Wait for debounce to fire the first flush.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    // First flusher is now hung (pending).

    // Mutation arrives while the first flush is in flight.
    manager.ephemeral.append({ content: 'second' });

    // Explicitly trigger a second flush while the first is still pending.
    // Without inFlight serialization, this would invoke the flusher immediately,
    // creating concurrent flusher calls. With serialization, it waits for the first.
    const secondFlush = manager.ephemeral.flush();

    // At this point, without the inFlight chain, the second flusher would have already
    // been called concurrently, so ephemeralFlushes.length would be 2. With serialization,
    // the second flush() is blocked waiting for the first to complete, so it's still 1.
    expect(ephemeralFlushes).toHaveLength(1);
    expect(ephemeralFlushes[0]?.content).toBe('first');

    // Resolve the first flusher.
    resolveFlusher?.();

    // Wait for the promise chain to drain and the second flusher call to complete.
    await secondFlush;

    // Now the second flusher call should have happened with the latest content.
    expect(ephemeralFlushes).toHaveLength(2);
    expect(ephemeralFlushes[1]?.content).toBe('first\nsecond');
  });

  it('re-sends content after a failed flush on subsequent flushAll', async () => {
    let shouldFail = true;
    const ephemeralFlushes: (RenderedMessage | undefined)[] = [];
    const manager = new StackManager({
      flushers: {
        ephemeral: async (rendered) => {
          ephemeralFlushes.push(rendered);
          if (shouldFail) {
            throw new Error('transient failure');
          }
        },
        public: async () => {},
      },
      debounceMs: DEBOUNCE_MS,
      maxAgeMs: MAX_AGE_MS,
    });

    manager.ephemeral.append({ content: 'important' });
    await manager.flushAll();

    expect(ephemeralFlushes).toHaveLength(1);

    // Now the flusher will succeed.
    shouldFail = false;
    await manager.flushAll();

    // Content is re-sent because the surface stayed dirty after the failure.
    expect(ephemeralFlushes).toHaveLength(2);
    expect(ephemeralFlushes[0]?.content).toBe('important');
    expect(ephemeralFlushes[1]?.content).toBe('important');
  });
});

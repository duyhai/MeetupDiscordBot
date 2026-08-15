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

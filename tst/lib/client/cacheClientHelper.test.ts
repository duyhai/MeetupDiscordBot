import { Logger } from 'tslog';
import { describe, expect, it, vi } from 'vitest';

import {
  cachedClientRequest,
  cacheLogger,
} from '../../../src/lib/client/cacheClientHelper.js';

// Each test uses a unique request name so the shared in-memory cache
// singleton cannot leak state between cases.
const uniqueName = (label: string) =>
  `${label}-${Math.floor(performance.now() * 1000)}`;

describe('cachedClientRequest', () => {
  it('calls through on a miss and serves the cached value afterwards', async () => {
    const name = uniqueName('miss-then-hit');
    const datagen = vi.fn().mockResolvedValue({ value: 42 });

    const first = await cachedClientRequest(name, { id: 'a' }, datagen);
    const second = await cachedClientRequest(name, { id: 'a' }, datagen);

    expect(first).toEqual({ value: 42 });
    expect(second).toEqual({ value: 42 });
    // The whole point of the cache: the second call must not hit the API.
    expect(datagen).toHaveBeenCalledTimes(1);
  });

  it('keys on the input, so different inputs each fetch once', async () => {
    const name = uniqueName('per-input');
    const datagen = vi.fn(async (input: { id: string }) => ({ id: input.id }));

    await cachedClientRequest(name, { id: 'a' }, datagen);
    await cachedClientRequest(name, { id: 'b' }, datagen);
    await cachedClientRequest(name, { id: 'a' }, datagen);

    expect(datagen).toHaveBeenCalledTimes(2);
  });

  // A badge computation fans out over every past event and every RSVP of
  // each, so one line per cache hit floods the log: 393 of the 400 lines
  // Heroku retained during a real onboarding were cache hits, which pushed
  // the evidence of an actual failure out of the buffer within minutes.
  // tslog's transport is captured here rather than a process stream, because
  // it does not write through one that a spy can intercept.
  it('emits no cache-hit output at the default log level', async () => {
    const name = uniqueName('quiet');
    const datagen = vi.fn().mockResolvedValue({ value: 1 });
    await cachedClientRequest(name, { id: 'a' }, datagen);

    const lines: string[] = [];
    const attach = (logger: Logger<unknown>) =>
      logger.attachTransport((entry) => lines.push(JSON.stringify(entry)));
    attach(cacheLogger);
    try {
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cachedClientRequest(name, { id: 'a' }, datagen);
      }
    } finally {
      cacheLogger.settings.attachedTransports.length = 0;
    }

    // Transports only receive entries that pass minLevel, so an empty capture
    // proves the hits are suppressed rather than merely reformatted.
    expect(lines.join('')).not.toMatch(/Cache hit/);
    expect(lines).toHaveLength(0);
  });
});

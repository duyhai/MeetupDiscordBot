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

  private inFlight: Promise<void> | undefined;

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

  remove(id: EntryId): void {
    this.stack.remove(id);
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
    const run = (this.inFlight ?? Promise.resolve()).then(() =>
      this.publishPending(),
    );
    // Swallow here so one failure can't poison the chain for later flushes.
    this.inFlight = run.catch((): void => undefined);
    await run;
  }

  /** Publishes pending state. Restores dirty flag on failure. Never throws. */
  private async publishPending(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    if (this.options.isExpired()) {
      this.dirty = false;
      return;
    }
    this.dirty = false;
    try {
      await this.flusher(this.stack.render());
    } catch (error) {
      // Keep the surface dirty so the state is not silently dropped.
      this.dirty = true;
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

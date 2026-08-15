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

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

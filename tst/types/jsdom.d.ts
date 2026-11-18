/**
 * The little of jsdom the kit's DOM test uses. Not @types/jsdom on purpose:
 * it references the DOM lib, which would make browser globals type-check
 * everywhere in this Node project (and changes ReadableStream's type).
 */
declare module 'jsdom' {
  export class VirtualConsole {
    on(event: 'jsdomError', fn: (error: Error) => void): this;
  }
  export class JSDOM {
    constructor(
      html: string,
      options?: {
        runScripts?: 'outside-only';
        url?: string;
        pretendToBeVisual?: boolean;
        virtualConsole?: VirtualConsole;
      },
    );
    /** Typed by the test itself, structurally. */
    readonly window: unknown;
  }
}

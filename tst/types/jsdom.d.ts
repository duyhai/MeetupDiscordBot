/**
 * The little of jsdom the kit's DOM test uses. Not @types/jsdom on purpose:
 * it references the DOM lib, which would make browser globals type-check
 * everywhere in this Node project (and changes ReadableStream's type).
 */
declare module 'jsdom' {
  export class JSDOM {
    constructor(html: string, options?: { runScripts?: 'outside-only' });
    /** Typed by the test itself, structurally. */
    readonly window: unknown;
  }
}

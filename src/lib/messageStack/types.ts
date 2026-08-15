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

import { EntryId, EntryStatus, RenderedMessage, StackEntry } from './types.js';

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

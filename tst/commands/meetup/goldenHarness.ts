import { CommandInteraction } from 'discord.js';

export type GoldenEvent =
  | { kind: 'editReply'; args: unknown }
  | {
      kind: 'followUp';
      args: {
        content?: string;
        files?: { name: string }[];
        [field: string]: unknown;
      };
    }
  | { kind: 'attachment'; fileName: string; data: string }
  | { kind: 'moderationLog'; entry: unknown };

export interface GoldenRecorder {
  events: GoldenEvent[];
  reset(): void;
}

export function createRecorder(): GoldenRecorder {
  const events: GoldenEvent[] = [];
  return {
    events,
    reset() {
      events.length = 0;
    },
  };
}

export const GOLDEN_USER = {
  id: '999000999',
  username: 'golden-mod',
  toString: () => '<@999000999>',
};

/** Just enough of a CommandInteraction for the commands under test. */
export function fakeInteraction(recorder: GoldenRecorder): CommandInteraction {
  return {
    user: GOLDEN_USER,
    editReply: (args: unknown) => {
      recorder.events.push({ kind: 'editReply', args });
      return Promise.resolve();
    },
    followUp: (args: Extract<GoldenEvent, { kind: 'followUp' }>['args']) => {
      recorder.events.push({ kind: 'followUp', args });
      return Promise.resolve();
    },
  } as unknown as CommandInteraction;
}

function render(event: GoldenEvent, bodies: Map<string, string>): string {
  switch (event.kind) {
    case 'editReply':
      return `--- editReply ---\n${JSON.stringify(event.args, null, 2)}`;
    case 'followUp':
      return `--- followUp ---\n${JSON.stringify(
        {
          ...event.args,
          files: event.args.files?.map((file) => ({
            name: file.name,
            body: bodies.get(file.name),
          })),
        },
        null,
        2,
      )}`;
    case 'attachment':
      return `--- attachment ${event.fileName} ---\n${event.data}\n--- end attachment ---`;
    case 'moderationLog':
      return `--- moderation log ---\n${JSON.stringify(event.entry, null, 2)}`;
    default:
      throw new Error('unreachable golden event');
  }
}

export function transcript(recorder: GoldenRecorder): string {
  const bodies = new Map<string, string>();
  recorder.events.forEach((event) => {
    if (event.kind === 'attachment') {
      bodies.set(event.fileName, event.data);
    }
  });
  return `${recorder.events.map((event) => render(event, bodies)).join('\n')}\n`;
}

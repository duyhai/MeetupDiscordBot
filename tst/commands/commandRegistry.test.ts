import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const COMMANDS_DIR = join(__dirname, '../../src/commands');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith('.ts') && entry.name !== 'index.ts'
      ? [path]
      : [];
  });
}

/** Names of the `@Discord()` classes a command file exports. */
function discordClasses(source: string): string[] {
  return [...source.matchAll(/@Discord\(\)\s*export class (\w+)/g)].map(
    (match) => match[1],
  );
}

// A command class only reaches Discord if src/commands/index.ts lists it.
// /meetup_identity_report shipped without its entry and was never registered.
describe('command registry', () => {
  const index = readFileSync(join(COMMANDS_DIR, 'index.ts'), 'utf8');
  const registered = index.slice(index.indexOf('const Commands = ['));

  const classes = sourceFiles(COMMANDS_DIR).flatMap((file) =>
    discordClasses(readFileSync(file, 'utf8')),
  );

  it('finds the command classes', () => {
    expect(classes.length).toBeGreaterThan(10);
  });

  it.each(classes)('%s is listed in src/commands/index.ts', (name) => {
    expect(registered).toMatch(new RegExp(`\\b${name}\\b`));
  });
});

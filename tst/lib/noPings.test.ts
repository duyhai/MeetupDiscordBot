import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Nothing this bot posts may ping anyone (Hai, 2026-10-16). Embeds never
// ping, so the only ways to ping are a role/user mention in content and an
// allowedMentions list; this scan keeps both out of the source tree.
const ROOT = path.resolve(import.meta.dirname, '../..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === 'node_modules' ? [] : tsFiles(full);
    }
    return full.endsWith('.ts') ? [full] : [];
  });
}

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const sources = ['src', 'scripts']
  .flatMap((dir) => tsFiles(path.join(ROOT, dir)))
  .map((file) => ({
    file: path.relative(ROOT, file),
    text: stripComments(readFileSync(file, 'utf8')),
  }));

const offenders = (pattern: RegExp): string[] =>
  sources.filter(({ text }) => pattern.test(text)).map(({ file }) => file);

describe('no pings anywhere', () => {
  it('scans a real set of source files', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it('no source builds a role mention', () => {
    expect(offenders(/<@&\$\{/)).toEqual([]);
  });

  it('no allowedMentions lists roles, users or a parse type', () => {
    expect(
      offenders(/allowedMentions\s*:\s*\{[^}]*\b(roles|users|repliedUser)\b/),
    ).toEqual([]);
    expect(
      offenders(/allowed_mentions\s*:\s*\{[^}]*\b(roles|users)\b/),
    ).toEqual([]);
    expect(offenders(/parse\s*:\s*\[\s*['"]/)).toEqual([]);
  });
});

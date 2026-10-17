import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { findPingViolations } from './noPingsScan.js';

// Nothing this bot posts may ping anyone (Hai, 2026-10-16). The rules live in
// noPingsScan.ts (and are tested in noPingsScan.test.ts); this walks the real
// tree: every role-mention construct fails unless its file is on the
// allow-list, and every allowedMentions must be exactly { parse: [] }.
const ROOT = path.resolve(import.meta.dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === 'node_modules' ? [] : sourceFiles(full);
    }
    return /\.(ts|js)$/.test(full) ? [full] : [];
  });
}

const files = ['src', 'scripts']
  .flatMap((dir) => sourceFiles(path.join(ROOT, dir)))
  .map((file) => path.relative(ROOT, file));

const violations = (rule: string) =>
  files
    .flatMap((file) =>
      findPingViolations(file, readFileSync(path.join(ROOT, file), 'utf8')),
    )
    .filter((v) => v.rule === rule)
    .map((v) => v.detail);

describe('no pings anywhere', () => {
  it('scans src and the scripts, ts and js', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('scripts/auditLgbtqOverwrites.js');
    expect(files).toContain('scripts/backfillReports.ts');
  });

  it('no source builds a role mention outside the allow-list', () => {
    expect(violations('role mention')).toEqual([]);
  });

  it('every allowedMentions is exactly { parse: [] }', () => {
    expect(violations('allowedMentions')).toEqual([]);
  });
});

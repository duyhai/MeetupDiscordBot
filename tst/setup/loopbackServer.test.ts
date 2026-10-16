import express from 'express';
import fs from 'fs';
import { AddressInfo } from 'net';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { closeServers, listen, serve } from './loopbackServer.js';

afterEach(closeServers);

const root = path.resolve(__dirname, '../..');

// Any quoted specifier naming the package or one of its subpaths: static, side-effect,
// dynamic, multi-line and require forms. Built at runtime so this file's own
// source does not contain the quoted literal and match itself.
const quotedSupertest = new RegExp(`['"]${'super' + 'test'}(/[^'"]*)?['"]`);

const tsFilesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__goldens__' ? [] : tsFilesUnder(full);
    }
    return /\.(ts|mts|tsx)$/.test(entry.name) ? [full] : [];
  });

describe('loopbackServer', () => {
  it('serves on 127.0.0.1 only', async () => {
    const server = await listen(express());
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('a served app answers over loopback', async () => {
    const app = express();
    app.get('/ping', (_req, res) => {
      res.send('pong');
    });
    const client = await serve(app);
    expect((await client.get('/ping')).text).toBe('pong');
  });

  it('no file under tst/ but loopbackServer.ts imports supertest', () => {
    const importers = tsFilesUnder(path.join(root, 'tst'))
      .filter((file) => quotedSupertest.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file).split(path.sep).join('/'));
    expect(importers).toEqual(['tst/setup/loopbackServer.ts']);
  });

  it('closeServers closes every server', async () => {
    const server = await listen(express());
    expect(server.listening).toBe(true);
    await closeServers();
    expect(server.listening).toBe(false);
  });
});

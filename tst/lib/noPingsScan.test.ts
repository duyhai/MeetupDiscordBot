import { describe, expect, it } from 'vitest';

import { findPingViolations, stripComments } from './noPingsScan.js';

const hits = (text: string, file = 'src/x.ts') =>
  findPingViolations(file, text).map((v) => v.rule);

describe('stripComments', () => {
  it('removes line and block comments', () => {
    expect(stripComments('a // x\nb /* y */ c')).toBe('a \nb  c');
  });

  it('keeps // inside strings and templates', () => {
    expect(stripComments("const u = 'https://x'; // gone")).toBe(
      "const u = 'https://x'; ",
    );
    expect(stripComments('const u = `${base}//x`; const c = 1;')).toBe(
      'const u = `${base}//x`; const c = 1;',
    );
  });

  it('treats // after } as a comment when in code', () => {
    expect(stripComments('if (a) {}// <@&${id}>')).toBe('if (a) {}');
  });
});

describe('findPingViolations', () => {
  it('flags a role mention after a template ending in //x', () => {
    expect(hits('const a = `${base}//x`; const c = `<@&${id}>`;')).toContain(
      'role mention',
    );
  });

  it.each([
    "const m = '<@&' + id;",
    "const m = '<@&123>';",
    'const m = `<@& ${id}>`;',
    'const m = `<@&${ id }>`;',
    'const m = roleMention(id);',
  ])('flags %s', (code) => {
    expect(hits(code)).toContain('role mention');
  });

  it('ignores a role mention that is only in a comment', () => {
    expect(hits('// <@&${id}>\n/* <@&1> */')).toEqual([]);
  });

  it('allows only { parse: [] } as allowedMentions', () => {
    expect(hits('send({ allowedMentions: { parse: [] } });')).toEqual([]);
    expect(hits('send({ allowedMentions:{parse:[]} });')).toEqual([]);
    expect(hits('send({ allowedMentions: opts });')).toContain(
      'allowedMentions',
    );
    expect(hits('send({ allowedMentions: { ...o, parse: [] } });')).toContain(
      'allowedMentions',
    );
    expect(hits('send({ allowedMentions: { parse: ALL } });')).toContain(
      'allowedMentions',
    );
    expect(hits("send({ allowedMentions: { parse: ['roles'] } });")).toContain(
      'allowedMentions',
    );
    expect(hits('send({ allowedMentions });')).toContain('allowedMentions');
  });

  it('applies the same shape rule to allowed_mentions', () => {
    expect(hits('x({ allowed_mentions: { parse: [] } })')).toEqual([]);
    expect(hits('x({ allowed_mentions: opts })')).toContain('allowedMentions');
  });

  it('exempts only the listed files from the role-mention rule', () => {
    const code = 'const m = `<@&${id}>`;';
    expect(hits(code, 'src/buttonMenu/messageMods.ts')).toEqual([]);
    expect(hits(code, 'src/buttonMenu/other.ts')).toContain('role mention');
  });

  it('never exempts the allowedMentions shape rule', () => {
    expect(
      hits('x({ allowedMentions: opts })', 'src/buttonMenu/messageMods.ts'),
    ).toContain('allowedMentions');
  });
});

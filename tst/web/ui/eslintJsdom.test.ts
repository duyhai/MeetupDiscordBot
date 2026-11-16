/**
 * jsdom is a devDependency, so it is pruned from the Heroku slug: an import
 * of it under src/ would pass every test and crash the dyno at boot. The
 * lint config forbids it there (no-restricted-imports) and allows it in tst/.
 */
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

type RuleEntry = [
  string,
  { paths?: { name: string }[]; patterns?: { group: string[] }[] },
];

async function restricted(file: string): Promise<RuleEntry | undefined> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const config = (await eslint.calculateConfigForFile(file)) as {
    rules?: Record<string, unknown>;
  };
  return config.rules?.['no-restricted-imports'] as RuleEntry | undefined;
}

describe('ESLint: no jsdom under src/', () => {
  it('forbids jsdom and jsdom/* in src/', async () => {
    for (const file of ['src/web/ui/script.ts', 'src/index.ts']) {
      // eslint-disable-next-line no-await-in-loop -- two files, in order
      const rule = await restricted(file);
      expect([2, 'error']).toContain(rule?.[0]);
      expect(rule?.[1].paths?.map((p) => p.name)).toContain('jsdom');
      expect(rule?.[1].patterns?.flatMap((p) => p.group)).toContain('jsdom/*');
    }
  });

  it('leaves tests free to use it', async () => {
    const rule = await restricted('tst/web/ui/kitDom.test.ts');
    expect(rule?.[1]?.paths?.map((p) => p.name) ?? []).not.toContain('jsdom');
  });

  it('reports an import of it in a src file', async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(
      "import { JSDOM } from 'jsdom';\nexport const d = JSDOM;\n",
      // A real src file's path, so typed linting has its project; the text is ours.
      { filePath: 'src/web/ui/linkButton.ts' },
    );
    const ids = result.messages.map((m) => m.ruleId);
    expect(ids).toContain('no-restricted-imports');
  });
});

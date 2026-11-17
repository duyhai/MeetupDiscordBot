/**
 * jsdom is a devDependency, so it is pruned from the Heroku slug: an import
 * of it under src/ would pass every test and crash the dyno at boot. The
 * lint config forbids it there (no-restricted-imports) and allows it in tst/.
 *
 * Type-aware linting is slow (seconds per file in CI), so the lint run here
 * uses a minimal untyped config: the TypeScript parser plus the real config's
 * own src/ block, taken from eslint.config.js.
 */
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

import realConfig from '../../../eslint.config.js';

type RuleEntry = [
  string | number,
  { paths?: { name: string }[]; patterns?: { group: string[] }[] },
];

const TIMEOUT = 60_000;

/** The real config's block that restricts imports under src/. */
const srcBlock = (realConfig as Linter.Config[]).find(
  (c) =>
    c.rules?.['no-restricted-imports'] !== undefined &&
    c.files?.includes('src/**/*.ts'),
);

describe('ESLint: no jsdom under src/', () => {
  let real: ESLint;
  let untyped: ESLint;
  beforeAll(() => {
    real = new ESLint({ cwd: process.cwd() });
    untyped = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
        },
        srcBlock ?? {},
      ],
    });
  });

  const restricted = async (file: string) => {
    const config = (await real.calculateConfigForFile(file)) as {
      rules?: Record<string, unknown>;
    };
    return config.rules?.['no-restricted-imports'] as RuleEntry | undefined;
  };

  it('the real config has the src/ block', () => {
    expect(srcBlock).toBeDefined();
  });

  it(
    'forbids jsdom and jsdom/* in src/',
    async () => {
      for (const file of ['src/web/ui/script.ts', 'src/index.ts']) {
        // eslint-disable-next-line no-await-in-loop -- two files, in order
        const rule = await restricted(file);
        expect([2, 'error']).toContain(rule?.[0]);
        expect(rule?.[1].paths?.map((p) => p.name)).toContain('jsdom');
        expect(rule?.[1].patterns?.flatMap((p) => p.group)).toContain(
          'jsdom/*',
        );
      }
    },
    TIMEOUT,
  );

  it(
    'leaves tests free to use it',
    async () => {
      const rule = await restricted('tst/web/ui/kitDom.test.ts');
      expect(rule?.[1]?.paths?.map((p) => p.name) ?? []).not.toContain('jsdom');
    },
    TIMEOUT,
  );

  it(
    'reports an import of it, or of a jsdom/* path, in a src file and not in a test',
    async () => {
      const code =
        "import { JSDOM } from 'jsdom';\nimport x from 'jsdom/lib/api.js';\nexport const d = [JSDOM, x];\n";
      const [inSrc] = await untyped.lintText(code, {
        filePath: 'src/web/ui/notARealFile.ts',
      });
      expect(
        inSrc.messages.filter((m) => m.ruleId === 'no-restricted-imports'),
      ).toHaveLength(2);
      const [inTst] = await untyped.lintText(code, {
        filePath: 'tst/web/ui/notARealFile.test.ts',
      });
      expect(
        inTst.messages.filter((m) => m.ruleId === 'no-restricted-imports'),
      ).toHaveLength(0);
    },
    TIMEOUT,
  );
});

import stylistic from '@stylistic/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist/', 'coverage/', 'node_modules/', '**/*.ipynb']),
  {
    files: ['**/*.ts'],
    extends: [
      tseslint.configs.recommendedTypeChecked,
      importX.flatConfigs.recommended,
      importX.flatConfigs.typescript,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@stylistic': stylistic,
    },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver()],
    },
    rules: {
      // Carried over from the old .eslintrc.json for behavior parity
      'class-methods-use-this': 'off',
      curly: ['error', 'all'],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Parity with the old setup: these type-checked rules are new in
      // recommendedTypeChecked and flag existing accepted code, so they are
      // configured down rather than churning source files.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      // The old eslint-plugin-import could not resolve these CJS-interop
      // modules, so this rule never fired; keep it off for parity.
      'import-x/no-named-as-default-member': 'off',
      // Previously provided by airbnb-typescript-base; kept because the
      // codebase relies on them (disable comments / import hygiene)
      'no-await-in-loop': 'error',
      'no-console': 'warn',
      'import-x/prefer-default-export': 'off',
      'import-x/extensions': ['error', 'ignorePackages', { ts: 'never' }],
      'import-x/no-extraneous-dependencies': [
        'error',
        { devDependencies: false, optionalDependencies: false },
      ],
      'import-x/order': [
        'error',
        { groups: [['builtin', 'external', 'internal']] },
      ],
      'import-x/first': 'error',
      'import-x/no-duplicates': 'error',
      'import-x/newline-after-import': 'error',
    },
  },
  // html``, staticHtml`` and staticRaw`` live in src/web/html.ts and are
  // used only under src/web and tst/web (other code has unrelated `html`
  // variables, so the value-use ban is scoped there, and reaching the tags
  // from anywhere else is refused).
  {
    files: ['src/web/**/*.ts', 'tst/web/**/*.ts'],
    rules: {
      // The tags mint SafeHtml only as tagged templates: any other use of
      // the function as a value (a call, an alias, Reflect.apply,
      // (0, html)(x), [html][0], H['html'], H.html) could hand it a forged
      // strings array. Allowed: a tagged template's tag, their own
      // declaration, a type query, and un-aliased imports.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Identifier[name=/^(html|staticHtml|staticRaw)$/]' +
            ':not(TaggedTemplateExpression > Identifier.tag)' +
            ':not(FunctionDeclaration > Identifier.id)' +
            ':not(ImportSpecifier > Identifier)' +
            ':not(ExportSpecifier > Identifier)' +
            ':not(TSTypeQuery > Identifier.exprName)',
          message:
            'Use html`…` / staticHtml`…` / staticRaw`…` only as a tagged template, never as a value.',
        },
        {
          selector:
            'MemberExpression[computed=true] > Literal.property[value=/^(html|staticHtml|staticRaw)$/]',
          message:
            'Use html`…` / staticHtml`…` / staticRaw`…` only as a tagged template, never as a value.',
        },
        ...['html', 'staticHtml', 'staticRaw'].map((name) => ({
          selector: `ImportSpecifier[imported.name='${name}'][local.name!='${name}']`,
          message: `Import ${name} under its own name, so lint can see every use.`,
        })),
        {
          // Only html.ts declares them; nothing re-exports them.
          selector:
            'ExportSpecifier[local.name=/^(html|staticHtml|staticRaw)$/]',
          message: 'Do not re-export the html tags: import them from html.ts.',
        },
        {
          selector: 'ExportAllDeclaration[source.value=/(^|\\/)html\\.js$/]',
          message: 'Do not re-export html.ts: import from it directly.',
        },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    ignores: ['src/web/**', 'tst/web/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportDeclaration[source.value=/(^|\\/)web\\/html\\.js$/] > ImportSpecifier[imported.name=/^(html|staticHtml|staticRaw)$/]',
          message:
            'The html tags are used only under src/web and tst/web, where lint checks every use.',
        },
        {
          selector:
            'ImportDeclaration[source.value=/(^|\\/)web\\/html\\.js$/] > ImportNamespaceSpecifier',
          message:
            'No namespace import of web/html.js outside src/web and tst/web.',
        },
        {
          selector:
            'ImportExpression[source.value=/(^|\\/)web\\/html(\\.js)?$/]',
          message:
            'No dynamic import of web/html.js outside src/web and tst/web.',
        },
        {
          selector:
            'ExportAllDeclaration[source.value=/(^|\\/)web\\/html\\.js$/]',
          message: 'Do not re-export web/html.js.',
        },
      ],
    },
  },
  {
    files: ['tst/**/*.ts', 'vitest.config.ts', 'vitest.integration.config.ts'],
    rules: {
      'import-x/no-extraneous-dependencies': [
        'error',
        { devDependencies: true },
      ],
    },
  },
  // Disables stylistic rules that conflict with Prettier and enables the
  // prettier/prettier rule (options come from .prettierrc.json)
  prettierRecommended,
  // The old .eslintrc.json declared these in top-level `rules`, which took
  // precedence over eslint-config-prettier's blanket disables — so they were
  // active alongside Prettier. Keep them after prettierRecommended to
  // preserve that behavior. (Core max-len & friends were removed in ESLint
  // 10; these are their @stylistic equivalents.)
  {
    files: ['**/*.ts'],
    rules: {
      '@stylistic/max-len': ['error', { code: 140, ignoreUrls: true }],
      '@stylistic/no-confusing-arrow': ['error', { allowParens: false }],
      // Pinned to core no-mixed-operators' default groups: the @stylistic
      // fork added arithmetic operators to its defaults, which would newly
      // flag existing `a + b * c` expressions the old setup accepted.
      '@stylistic/no-mixed-operators': [
        'error',
        {
          groups: [
            ['&', '|', '^', '~', '<<', '>>', '>>>'],
            ['==', '!=', '===', '!==', '>', '>=', '<', '<='],
            ['&&', '||'],
            ['in', 'instanceof'],
          ],
        },
      ],
      '@stylistic/no-tabs': ['error', { allowIndentationTabs: true }],
      '@stylistic/linebreak-style': ['error', 'unix'],
    },
  },
);

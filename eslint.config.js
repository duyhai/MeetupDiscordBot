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

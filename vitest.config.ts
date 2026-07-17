import { defineConfig } from 'vitest/config';

// Unit tests (`yarn test`): everything under tst/ except tst/integration/.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tst/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tst/integration/**'],
  },
});

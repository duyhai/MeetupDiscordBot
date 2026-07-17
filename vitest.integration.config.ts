import { defineConfig } from 'vitest/config';

// Integration tests (`yarn test:integration`): only tst/integration/.
// Redis + fake HTTP interception can be slower than pure unit tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tst/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 20000,
  },
});

import { defineConfig } from 'vitest/config';

// Integration tests (`yarn test:integration`): only tst/integration/.
// Redis + fake HTTP interception can be slower than pure unit tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tst/integration/**/*.test.ts'],
    // Runs once per test file: gives each a cold cache (see setup.ts).
    setupFiles: ['tst/integration/setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/setup.ts'],
    testTimeout: 20000,
    env: {
      DISCORD_CLIENT_ID: 'discord-client-id',
      DISCORD_SECRET: 'discord-secret',
      MEETUP_KEY: 'meetup-key',
      MEETUP_SECRET: 'meetup-secret',
    },
  },
});

import { defineConfig } from 'vitest/config';

// Integration tests (`yarn test:integration`): only tst/integration/.
// Redis + fake HTTP interception can be slower than pure unit tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tst/integration/**/*.test.ts'],
    // These files share global state -- one Redis, one Postgres, and the
    // cache/repository singletons behind them -- so they are not independent
    // and must not run concurrently. Running them in parallel let one file's
    // cold-cache flush wipe OAuth state another file was mid-test with.
    fileParallelism: false,
    // Runs once per test file, serially: gives each a cold cache (see setup.ts).
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

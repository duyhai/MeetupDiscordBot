/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  testMatch: ['<rootDir>/tst/integration/**/*.test.ts'],
  // Redis + fake HTTP interception can be slower than pure unit tests.
  testTimeout: 20000,
  // InMemoryCache/RedisCache singletons keep timers/connections open past
  // the last test; that's fine for a real long-running process but Jest
  // otherwise waits a while before reporting "did not exit".
  forceExit: true,
};

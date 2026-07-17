/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  testMatch: ['<rootDir>/tst/integration/**/*.test.ts'],
  // Redis + fake HTTP interception can be slower than pure unit tests.
  testTimeout: 20000,
  // InMemoryCache/RedisCache singletons keep timers/connections open past
  // the last test; that's fine for a real long-running process but Jest
  // otherwise waits a while before reporting "did not exit".
  forceExit: true,
  // Jest still runs the suite as CommonJS: have ts-jest emit CJS (overriding
  // the project's nodenext ESM settings) and strip the ESM-mandated `.js`
  // suffix from relative imports so they resolve to the `.ts` sources.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
        },
      },
    ],
  },
};

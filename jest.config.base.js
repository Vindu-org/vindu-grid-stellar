// Shared Jest settings. Each workspace has a jest.config.js that spreads this
// and runs its own tests, so `yarn workspace <name> test` works on its own.
const path = require('node:path');

/** @type {(packageDir: string) => import('jest').Config} */
module.exports = (packageDir) => ({
  rootDir: packageDir,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: path.join(packageDir, 'tsconfig.json') }],
  },
  // Workspace packages resolve to their sources in tests, so no build is needed first.
  moduleNameMapper: {
    '^@vindu/(grid-[a-z]+)$': path.join(__dirname, 'packages/$1/src'),
  },
  clearMocks: true,
  restoreMocks: true,
});

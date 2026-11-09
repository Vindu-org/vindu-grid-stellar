// Shared Jest settings. Each workspace has a jest.config.js that spreads this
// and runs its own tests, so `yarn workspace <name> test` works on its own.
const path = require('node:path');

/** @type {(packageDir: string) => import('jest').Config} */
module.exports = (packageDir) => ({
  rootDir: packageDir,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: path.join(packageDir, 'tsconfig.json'),
        // TS151002 warns that node16 module mode is "hybrid". Packages have no
        // "type": "module", so every file compiles to CommonJS and Jest runs it
        // as is. Full type checking stays on.
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },
  // Workspace packages resolve to their sources in tests, so no build is needed first.
  moduleNameMapper: {
    '^@vindu/(grid-[a-z]+)$': path.join(__dirname, 'packages/$1/src'),
  },
  clearMocks: true,
  restoreMocks: true,
});

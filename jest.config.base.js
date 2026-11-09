// Shared Jest settings. Each workspace has a jest.config.js that calls this
// and runs its own tests, so `yarn workspace <name> test` works on its own.
const path = require('node:path');

// The Stellar SDK's CommonJS build requires a few packages that ship only as
// ES modules. Node 22.12+ loads them natively, but Jest's module loader does
// not, so workspaces that load the SDK compile just these packages to CommonJS.
const STELLAR_SDK_ESM_ONLY = ['uint8array-extras', '@noble/hashes', '@noble/ed25519', '@exodus/bytes'];

/**
 * @param {string} packageDir the workspace directory (`__dirname` of its jest.config.js)
 * @param {{ stellarSdk?: boolean }} [options] `stellarSdk: true` for workspaces whose tests load the Stellar SDK
 * @returns {import('jest').Config}
 */
module.exports = (packageDir, options = {}) => ({
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
    ...(options.stellarSdk
      ? {
          '^.+\\.js$': [
            'ts-jest',
            {
              tsconfig: { allowJs: true, module: 'commonjs', target: 'ES2022', esModuleInterop: true },
              isolatedModules: true,
            },
          ],
        }
      : {}),
  },
  ...(options.stellarSdk
    ? { transformIgnorePatterns: [`/node_modules/(?!(${STELLAR_SDK_ESM_ONLY.join('|')})/)`] }
    : {}),
  // Workspace packages resolve to their sources in tests, so no build is needed first.
  moduleNameMapper: {
    '^@vindu/(grid-[a-z]+)$': path.join(__dirname, 'packages/$1/src'),
  },
  clearMocks: true,
  restoreMocks: true,
});

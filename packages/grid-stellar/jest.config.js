const base = require('../../jest.config.base.js')(__dirname);

// The Stellar SDK's CommonJS build requires a few packages that ship only as
// ES modules. Node 22.12+ loads them natively, but Jest's module loader does
// not, so tests compile just these packages to CommonJS.
const ESM_ONLY = ['uint8array-extras', '@noble/hashes', '@noble/ed25519', '@exodus/bytes'];

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  transform: {
    ...base.transform,
    '^.+\\.js$': [
      'ts-jest',
      {
        tsconfig: { allowJs: true, module: 'commonjs', target: 'ES2022', esModuleInterop: true },
        isolatedModules: true,
      },
    ],
  },
  transformIgnorePatterns: [`/node_modules/(?!(${ESM_ONLY.join('|')})/)`],
};

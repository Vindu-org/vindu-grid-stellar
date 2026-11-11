// The unit tests are offline: test/offline.cjs makes any fetch throw, so a test
// that reaches for Horizon or friendbot fails instead of calling them.
module.exports = {
  ...require('../../jest.config.base.js')(__dirname, { stellarSdk: true }),
  setupFiles: ['<rootDir>/test/offline.cjs'],
};

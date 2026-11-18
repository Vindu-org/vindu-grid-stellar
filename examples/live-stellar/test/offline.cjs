// Loaded before every test file (see jest.config.js): no network in unit tests.
globalThis.fetch = () => {
  throw new Error('live-stellar unit tests are offline: fetch is disabled');
};

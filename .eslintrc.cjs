const { builtinModules } = require('node:module');

// Layering: core is pure TypeScript, the BlindPay client stays free of the
// Stellar SDK, and the Stellar layer knows no partner. These overrides make a
// wrong import a lint error.
const NODE_BUILTINS = builtinModules.filter((name) => !name.startsWith('_'));
const PURE_CORE = 'grid-core is pure: no Node built-ins, no Stellar SDK, no other @vindu package, no network.';
const NO_STELLAR_SDK = 'grid-blindpay must not depend on the Stellar SDK or on grid-stellar.';
const NO_PARTNER = 'grid-stellar must not depend on a partner adapter such as grid-blindpay.';

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  rules: {
    eqeqeq: ['error', 'always'],
    'no-console': 'error',
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    // The library never reads configuration from the environment.
    'no-restricted-properties': [
      'error',
      { object: 'process', property: 'env', message: 'Pass configuration as arguments.' },
    ],
  },
  overrides: [
    {
      files: ['*.js', '*.cjs'],
      rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
    {
      files: ['examples/**/*.ts'],
      rules: { 'no-console': 'off' },
    },
    {
      files: ['packages/grid-core/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: NODE_BUILTINS.map((name) => ({ name, message: PURE_CORE })),
            patterns: [
              { group: ['node:*', 'node:*/**'], message: PURE_CORE },
              { group: NODE_BUILTINS.map((name) => `${name}/**`), message: PURE_CORE },
              { group: ['@stellar/*', '@stellar/**'], message: PURE_CORE },
              { group: ['@vindu/*', '@vindu/**'], message: PURE_CORE },
            ],
          },
        ],
        'no-restricted-globals': ['error', { name: 'fetch', message: PURE_CORE }],
      },
    },
    {
      files: ['packages/grid-blindpay/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [{ name: '@vindu/grid-stellar', message: NO_STELLAR_SDK }],
            patterns: [
              { group: ['@stellar/*', '@stellar/**'], message: NO_STELLAR_SDK },
              { group: ['@vindu/grid-stellar/**'], message: NO_STELLAR_SDK },
            ],
          },
        ],
      },
    },
    {
      files: ['packages/grid-stellar/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [{ name: '@vindu/grid-blindpay', message: NO_PARTNER }],
            patterns: [{ group: ['@vindu/grid-blindpay/**'], message: NO_PARTNER }],
          },
        ],
      },
    },
  ],
};

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
  ],
};

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.output/**',
      '.wxt/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'scripts/**',
      // Read-only kit tooling: not app source; fingerprint excludes it too.
      'block-the-slop-agent-kit/**',
      'block-the-slop-upgrade-agent-kit/**',
      '.agents/**',
      'archives/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.serviceworker, ...globals.node },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'tests/e2e/**/*.ts', 'tests/setup.ts', 'tests/utils.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
);

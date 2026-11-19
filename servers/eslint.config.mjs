import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const providers = ['@google/**', '@runwayml/**', '@fal-ai/**', '**/providers/adapters/**'];
/** Import rules are shared with architecture fixtures; no custom analyzer. */
export const boundaries = [
  {
    files: ['src/domain/**/*.ts', 'src/**/domain/**/*.ts', 'src/routes/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: providers }] },
  },
  {
    files: ['src/domain/**/*.ts', 'src/**/domain/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [...providers, 'hono', 'hono/**', '@hono/**'] }] },
  },
  {
    files: ['clients/**/*.ts', 'clients/**/*.tsx'],
    rules: { 'no-restricted-imports': ['error', { patterns: [...providers, '**/servers/**', '**/db/**', '**/config/env*', 'postgres', 'drizzle-orm', 'drizzle-orm/**'] }] },
  },
];

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.check.json', tsconfigRootDir: root },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': true }],
    },
  },
  ...boundaries,
];

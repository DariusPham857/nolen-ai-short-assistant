import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';
const restricted = ['@nolen/server', '@nolen/server/**', '**/servers/**', 'postgres', 'drizzle-orm', 'drizzle-orm/**', '**/config/env*'];
export default [{
  files: ['**/*.ts', '**/*.tsx'],
  languageOptions: { parser: tseslint.parser, parserOptions: { project: './tsconfig.json', tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)) } },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error', '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/ban-ts-comment': 'error',
    'no-restricted-imports': ['error', { patterns: restricted }],
  },
}, {
  files: ['lib/server.ts', 'instrumentation.ts'], rules: { 'no-restricted-imports': 'off' },
}];

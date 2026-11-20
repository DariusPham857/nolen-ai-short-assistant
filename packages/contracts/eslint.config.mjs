import tseslint from 'typescript-eslint';
export default [{ files: ['src/**/*.ts'], languageOptions: { parser: tseslint.parser },
  rules: { 'no-restricted-imports': ['error', { patterns: ['node:*', '**/servers/**', '**/clients/**', '@nolen/server', '@nolen/server/**', 'server-only', 'postgres', 'drizzle-orm', 'drizzle-orm/**'] }] } }];

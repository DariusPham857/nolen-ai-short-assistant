import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { spawnSync } from 'node:child_process';
import { boundaries } from '../eslint.config.mjs';

const imports = new ESLint({ overrideConfigFile: true, overrideConfig: [
  { files: ['**/*.ts', '**/*.tsx'], languageOptions: { parser: tseslint.parser } }, ...boundaries,
] });
/** Lint hypothetical paths with the exact boundary rules used in production config. */
async function restricted(code, filePath) {
  const [result] = await imports.lintText(code, { filePath });
  return result.messages.some(m => m.ruleId === 'no-restricted-imports');
}

test('UI and domain boundaries catch forbidden imports but allow contracts', async () => {
  assert.equal(await restricted('import x from "../../../servers/src/db/index.js";', 'clients/example.ts'), true);
  assert.equal(await restricted('import x from "../providers/adapters/runway.js";', 'src/domain/example.ts'), true);
  assert.equal(await restricted('import x from "hono";', 'src/domain/example.ts'), true);
  assert.equal(await restricted('import x from "../contracts/provider.js";', 'src/domain/example.ts'), false);
  assert.equal(await restricted('import x from "@runwayml/sdk";', 'src/routes/example.ts'), true);
});

test('typed lint catches unsafe assignment, suppression and floating promise', async () => {
  const eslint = new ESLint();
  const [positive] = await eslint.lintText('const value: unknown = JSON.parse("{}");\nvoid value;', { filePath: 'src/app.ts' });
  assert.equal(positive.errorCount, 0);
  const [negative] = await eslint.lintText('const value = JSON.parse("{}");\n// @ts-ignore\nPromise.resolve(value);', { filePath: 'src/app.ts' });
  for (const id of ['no-unsafe-assignment','ban-ts-comment','no-floating-promises']) {
    assert.ok(negative.messages.some(m => m.ruleId === `@typescript-eslint/${id}`), id);
  }
});

test('Vitest empty discovery is a failure, not a successful gate', () => {
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '__eng_dec_001_intentionally_absent__'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /No test files found/);
});

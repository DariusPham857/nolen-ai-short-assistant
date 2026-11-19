import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateDocument, validateDebt, validateLinks } from './check-evidence.mjs';

test('spec positive and missing acceptance negative', () => {
  const spec = readFileSync(new URL('../specs/film-creation/spec.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  assert.deepEqual(validateDocument(spec, 'spec'), []);
  assert.ok(validateDocument(spec.replace('## Acceptance criteria', '## Removed'), 'spec').length);
  assert.ok(validateDocument(spec.replace(/^Status:.*$/m, ''), 'spec').length);
});

test('tasks template positive and missing handoff negative', () => {
  const text = readFileSync(new URL('../specs/_template/tasks.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  assert.deepEqual(validateDocument(text, 'tasks'), []);
  assert.ok(validateDocument(text.replace('## Handoff', '## Removed'), 'tasks').length);
});

test('debt fixtures: approval and safeguards are mandatory for accepted debt', () => {
  const fields = ['Type','Owner','Scope','Cause','Tradeoff','Risk','Safeguards','Tests','Trigger','Removal','Related'].map(f => `${f}: fixture value`).join('\n');
  const accepted = `## TD-001 — fixture only\nStatus: ACCEPTED\n${fields}\nApproval: owner 2026-11-19 [evidence](fixture.md)`;
  assert.deepEqual(validateDebt(accepted), []);
  assert.ok(validateDebt(accepted.replace(/^Approval:.*$/m, '')).length);
  assert.ok(validateDebt(accepted.replace(/^Safeguards:.*$/m, '')).length);
  assert.ok(validateDebt(accepted.replace(/^Approval:.*$/m, 'Approval: PENDING')).length);
  assert.ok(validateDebt(`${accepted}\n${accepted}`).length);
  assert.deepEqual(validateDebt('# Empty debt tracker'), []);
});

test('local links positive and broken target negative', () => {
  const file = new URL('../README.md', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  assert.deepEqual(validateLinks('[spec](specs/README.md)', file), []);
  assert.ok(validateLinks('[missing](specs/does-not-exist.md)', file).length);
});

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
/** Check small Markdown templates without interpreting product semantics. */
export function validateDocument(text, kind) {
  const errors = [];
  const headings = kind === 'spec'
    ? ['Goal', 'Scope', 'Invariants', 'Acceptance criteria', 'Open Questions / Blocked Contracts']
    : ['Tasks', 'Handoff'];
  for (const heading of headings) {
    const section = text.split(`## ${heading}\n`)[1]?.split('\n## ')[0].trim();
    if (!section) errors.push(`Missing/nonempty section: ${heading}`);
  }
  if (!/^Status: \S.+$/m.test(text)) errors.push('Missing Status');
  if (!/^Source: \[.+\]\(.+\)/m.test(text)) errors.push('Missing linked Source');
  return errors;
}

/** Validate actual debt records; never infer human approval from a valid record. */
export function validateDebt(text) {
  const errors = [];
  const ids = new Set();
  for (const record of text.split(/^## (?=TD-)/m).slice(1)) {
    const id = record.match(/^TD-\d+/)?.[0];
    if (!id || ids.has(id)) errors.push('Invalid/duplicate debt ID');
    ids.add(id);
    const fields = Object.fromEntries([...record.matchAll(/^(\w+):[ \t]*(.*)$/gm)].map(m => [m[1], m[2].trim()]));
    for (const name of ['Type','Status','Owner','Scope','Cause','Tradeoff','Risk','Safeguards','Tests','Approval','Trigger','Removal','Related']) {
      if (!fields[name] || /^(TBD|TODO|NONE|N\/A)$/i.test(fields[name])) errors.push(`${id}: missing ${name}`);
    }
    if (!['PROPOSED','ACCEPTED','RESOLVED','REJECTED'].includes(fields.Status)) errors.push(`${id}: invalid status`);
    if (['ACCEPTED','RESOLVED'].includes(fields.Status) &&
        (!/\d{4}-\d{2}-\d{2}/.test(fields.Approval ?? '') || !/\[.+\]\(.+\)/.test(fields.Approval ?? '') || /PENDING/i.test(fields.Approval ?? ''))) {
      errors.push(`${id}: dated linked approval required`);
    }
  }
  return errors;
}

/** Check relative file links (not remote URLs or Markdown anchor semantics). */
export function validateLinks(text, file) {
  const errors = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    if (!existsSync(path.resolve(path.dirname(file), target))) errors.push(`Missing link: ${target}`);
  }
  return errors;
}

/** Enumerate only project-owned engineering documentation, not vendored references. */
function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? markdownFiles(file) : file.endsWith('.md') ? [file] : [];
  });
}

/** Run checks with a failing exit code for any structural violation. */
export function checkRepository() {
  const files = ['README.md','AGENTS.md','.github/pull_request_template.md','docs/DEBT.md'].map(f => path.join(root, f));
  for (const dir of ['specs', 'docs/development', '.agents/rules']) files.push(...markdownFiles(path.join(root, dir)));
  const errors = files.flatMap(file => {
    const text = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
    const structural = file.endsWith('spec.md') ? validateDocument(text, 'spec')
      : file.endsWith('tasks.md') ? validateDocument(text, 'tasks')
      : file.endsWith('DEBT.md') ? validateDebt(text) : [];
    return [...structural, ...validateLinks(text, file)].map(e => `${path.relative(root, file)}: ${e}`);
  });
  console.log(errors.length ? errors.join('\n') : `PASS: ${files.length} engineering documents (structure/file links only)`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = checkRepository();

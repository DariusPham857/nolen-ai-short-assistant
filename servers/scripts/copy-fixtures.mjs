import { cpSync, existsSync, mkdirSync } from 'node:fs';

const src = new URL('../fixtures', import.meta.url);
const dest = new URL('../dist/fixtures', import.meta.url);

if (existsSync(src)) {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

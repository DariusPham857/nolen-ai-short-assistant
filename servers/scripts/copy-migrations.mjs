import { cpSync } from 'node:fs';
// Keep SQL/catalog evidence beside compiled migrator; never regenerate on startup.
cpSync(new URL('../src/db/migrations',import.meta.url),new URL('../dist/db/migrations',import.meta.url),{recursive:true});

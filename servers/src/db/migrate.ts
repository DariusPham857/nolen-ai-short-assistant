import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';

export const migrationFolder = fileURLToPath(new URL('./migrations', import.meta.url));

/** Finite catalog fingerprint for FC-001 application objects, not a general diff engine. */
export async function inspectSchema(client: postgres.Sql, state = 1) {
  const objects = await client`SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','v','m','S','f') ORDER BY c.relname`;
  const columns = await client`SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,character_maximum_length
    FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`;
  const constraints = await client`SELECT t.relname, c.conname, c.contype, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' ORDER BY t.relname,c.conname`;
  const indexes = await client`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`;
  const enums = await client`SELECT t.typname,e.enumlabel,e.enumsortorder FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
    JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder`;
  const base = { objects: [...objects], columns: [...columns], constraints: [...constraints], indexes: [...indexes], enums: [...enums] };
  if (state < 2) return base;
  const triggers = await client`SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal AND (t.tgname LIKE 'sp_%' OR t.tgname LIKE 'fi_%' OR t.tgname LIKE 'kf_%') ORDER BY c.relname,t.tgname`;
  const functions = await client`SELECT p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('sp_guard_immutable','sp_guard_revision','sp_guard_waiver','fi_guard_append_only','kf_guard_append_only') ORDER BY p.proname`;
  return {...base,triggers:[...triggers],functions:[...functions]};
}

/** Verify the complete applied prefix and exact supported schema BEFORE any write. */
export async function preflight(client: postgres.Sql, folder = migrationFolder): Promise<void> {
  const files = readMigrationFiles({ migrationsFolder: folder });
  const [journal] = await client`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`;
  if (!journal?.name) {
    const schema = await inspectSchema(client,2);
    if (Object.values(schema).some(rows => rows.length)) throw new Error('SCHEMA_MISMATCH: unmanaged application schema');
    return;
  }
  const applied = await client`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
  const schema = await inspectSchema(client,applied.length===0?2:applied.length);
  if (applied.length > files.length) throw new Error('SCHEMA_MISMATCH: unknown migration');
  for (let i = 0; i < applied.length; i++) {
    if (applied[i].hash !== files[i].hash || String(applied[i].created_at) !== String(files[i].folderMillis)) {
      throw new Error('SCHEMA_MISMATCH: migration history differs');
    }
  }
  if (applied.length === 0) {
    if (Object.values(schema).some(rows => rows.length)) throw new Error('SCHEMA_MISMATCH: unjournaled schema');
    return;
  }
  const expected: unknown = JSON.parse(readFileSync(path.join(folder, 'meta', `state-${applied.length}.json`), 'utf8'));
  if (JSON.stringify(schema) !== JSON.stringify(expected)) throw new Error('SCHEMA_MISMATCH: application catalog differs');
}

/** Serialize migration processes on a dedicated connection; never reset or baseline drift. */
export async function migrateDatabase(url: string, folder = migrationFolder): Promise<void> {
  const client = postgres(url, { max: 1 });
  try {
    await client`SELECT pg_advisory_lock(1649001)`;
    await preflight(client, folder);
    await migrate(drizzle(client), { migrationsFolder: folder });
    await preflight(client, folder);
  } finally {
    await client`SELECT pg_advisory_unlock(1649001)`.catch(() => undefined);
    await client.end();
  }
}

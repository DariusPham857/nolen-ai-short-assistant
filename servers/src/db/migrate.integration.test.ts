import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { migrateDatabase, migrationFolder } from './migrate.js';

/** Create test-owned databases only, never reset the configured database. */
async function withDatabase(run: (url:string, client:postgres.Sql) => Promise<void>) {
  const base = process.env.DATABASE_URL!;
  const admin = postgres(base, {max:1});
  const name = `fc_${randomUUID().replaceAll('-','')}`;
  await admin`CREATE DATABASE ${admin(name)}`;
  const parsed = new URL(base); parsed.pathname = `/${name}`;
  const client = postgres(parsed.toString(),{max:1});
  try { await run(parsed.toString(),client); }
  finally { await client.end(); await admin`DROP DATABASE ${admin(name)}`; await admin.end(); }
}

it('migrates fresh database and accepts a complete valid journal repeatedly', async () => {
  await withDatabase(async (url, client) => {
    await migrateDatabase(url);
    await migrateDatabase(url);
    expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(1);
    expect(await client`SELECT * FROM films`).toHaveLength(0);
  });
});

it('unmanaged films blocks migration without changing sentinel data or journal', async () => {
  await withDatabase(async(url,client) => {
    await client`CREATE TABLE films (sentinel text)`;
    await client`INSERT INTO films VALUES ('preserve-me')`;
    await expect(migrateDatabase(url)).rejects.toThrow('SCHEMA_MISMATCH');
    expect((await client`SELECT sentinel FROM films`)[0].sentinel).toBe('preserve-me');
    expect((await client`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`)[0].name).toBeNull();
  });
});

it('detects journal hash change, catalog drift and edited applied SQL before mutation', async () => {
  await withDatabase(async(url,client) => {
    await migrateDatabase(url);
    await client`UPDATE drizzle.__drizzle_migrations SET hash='changed'`;
    await expect(migrateDatabase(url)).rejects.toThrow('migration history differs');
  });
  await withDatabase(async(url,client) => {
    await migrateDatabase(url);
    await client`ALTER TABLE films ADD COLUMN unexpected text DEFAULT 'sentinel'`;
    await expect(migrateDatabase(url)).rejects.toThrow('catalog differs');
    expect((await client`SELECT column_name FROM information_schema.columns WHERE table_name='films' AND column_name='unexpected'`)).toHaveLength(1);
  });
  await withDatabase(async(url) => {
    await migrateDatabase(url);
    const copy = mkdtempSync(path.join(tmpdir(),'fc-migrations-'));
    cpSync(migrationFolder, copy,{recursive:true});
    const journal = JSON.parse(readFileSync(path.join(copy,'meta/_journal.json'),'utf8')) as {entries:{tag:string}[]};
    const file = path.join(copy,`${journal.entries[0].tag}.sql`);
    writeFileSync(file,readFileSync(file,'utf8')+'\n-- modified after application\n');
    await expect(migrateDatabase(url,copy)).rejects.toThrow('migration history differs');
  });
});

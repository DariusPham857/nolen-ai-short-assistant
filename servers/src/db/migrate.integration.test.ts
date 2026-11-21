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
    expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(3);
    expect(await client`SELECT * FROM films`).toHaveLength(0);
  });
});

it('FI append-only trigger/function drift blocks migration before repair',async()=>{
  for(const mutation of ['ALTER TABLE cost_ledger_events DISABLE TRIGGER fi_cost_ledger_events_append_only','DROP TRIGGER fi_budget_limit_events_append_only ON budget_limit_events',"CREATE OR REPLACE FUNCTION fi_guard_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$"]){
    await withDatabase(async(url,client)=>{await migrateDatabase(url);await client.unsafe(mutation);await expect(migrateDatabase(url)).rejects.toThrow('SCHEMA_MISMATCH');expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(3);});
  }
});

it('SP guard trigger/function drift blocks migration before any repair',async()=>{
  for(const mutation of ['ALTER TABLE shot_revisions DISABLE TRIGGER sp_shot_revisions_immutable','DROP TRIGGER sp_shot_revisions_immutable ON shot_revisions',"CREATE OR REPLACE FUNCTION sp_guard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$"]){
    await withDatabase(async(url,client)=>{
      await migrateDatabase(url);await client.unsafe(mutation);
      await expect(migrateDatabase(url)).rejects.toThrow('SCHEMA_MISMATCH');
      expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(3);
    });
  }
});

it('upgrades an FC-only database without changing the original Film DTO or timestamps; unsupported data rolls back',async()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'fc-prefix-'));
  cpSync(migrationFolder,folder,{recursive:true});
  const journalFile=path.join(folder,'meta/_journal.json');
  const journal=JSON.parse(readFileSync(journalFile,'utf8')) as {entries:unknown[]};
  journal.entries=journal.entries.slice(0,1);writeFileSync(journalFile,JSON.stringify(journal));
  await withDatabase(async(url,client)=>{
    await migrateDatabase(url,folder);const id=randomUUID();
    await client`INSERT INTO films(id,title,brief,operator_id,idempotency_key,request_hash) VALUES(${id},'Legacy','Preserve me','local-operator',${randomUUID()},'legacy')`;
    const [before]=await client`SELECT * FROM films WHERE id=${id}`;
    await migrateDatabase(url);
    const [after]=await client`SELECT * FROM films WHERE id=${id}`;
    expect(after.created_at).toEqual(before.created_at);expect(after.updated_at).toEqual(before.updated_at);
    expect(after.create_receipt).toMatchObject({id,title:'Legacy',status:'DRAFT',activeStoryRevisionId:null});
    expect((await client`SELECT * FROM film_budget_accounts WHERE film_id=${id}`)[0]).toMatchObject({film_id:id,budget_limit_usd_micros:'0'});
    expect(await client`SELECT * FROM budget_limit_events WHERE film_id=${id}`).toHaveLength(1);
    await migrateDatabase(url);
  });
  await withDatabase(async(url,client)=>{
    await migrateDatabase(url,folder);
    await client`INSERT INTO films(title,brief,status,operator_id,idempotency_key,request_hash) VALUES('Unsupported','Preserve me','PLANNING','local-operator',${randomUUID()},'legacy')`;
    await expect(migrateDatabase(url)).rejects.toThrow();
    expect((await client`SELECT to_regclass('public.story_revisions') AS name`)[0].name).toBeNull();
    expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(1);
    expect((await client`SELECT title FROM films`)[0].title).toBe('Unsupported');
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

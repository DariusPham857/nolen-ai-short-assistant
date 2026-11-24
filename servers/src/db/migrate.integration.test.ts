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
    expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(7);
    expect(await client`SELECT * FROM films`).toHaveLength(0);
  });
});

it('FI append-only trigger/function drift blocks migration before repair',async()=>{
  for(const mutation of ['ALTER TABLE cost_ledger_events DISABLE TRIGGER fi_cost_ledger_events_append_only','DROP TRIGGER fi_budget_limit_events_append_only ON budget_limit_events',"CREATE OR REPLACE FUNCTION fi_guard_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$"]){
    await withDatabase(async(url,client)=>{await migrateDatabase(url);await client.unsafe(mutation);await expect(migrateDatabase(url)).rejects.toThrow('SCHEMA_MISMATCH');expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(7);});
  }
});

it('SP guard trigger/function drift blocks migration before any repair',async()=>{
  for(const mutation of ['ALTER TABLE shot_revisions DISABLE TRIGGER sp_shot_revisions_immutable','DROP TRIGGER sp_shot_revisions_immutable ON shot_revisions',"CREATE OR REPLACE FUNCTION sp_guard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$"]){
    await withDatabase(async(url,client)=>{
      await migrateDatabase(url);await client.unsafe(mutation);
      await expect(migrateDatabase(url)).rejects.toThrow('SCHEMA_MISMATCH');
      expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(7);
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

it('upgrades FI state-3 to state-4 without data loss and rejects incompatible pending projections atomically',async()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'fi-state-3-'));
  cpSync(migrationFolder,folder,{recursive:true});
  const journalFile=path.join(folder,'meta/_journal.json');
  const journal=JSON.parse(readFileSync(journalFile,'utf8')) as {entries:unknown[]};
  journal.entries=journal.entries.slice(0,3);writeFileSync(journalFile,JSON.stringify(journal));
  await withDatabase(async(url,client)=>{
    await migrateDatabase(url,folder);const id=randomUUID();
    await client`INSERT INTO films(id,title,brief,budget_limit_usd_micros,operator_id,idempotency_key,request_hash) VALUES(${id},'FI state-3','Preserve projection',100,'local-operator',${randomUUID()},'state-3')`;
    await client`INSERT INTO film_budget_accounts(film_id,operator_id,budget_limit_usd_micros,reserved_open_usd_micros,pending_liability_usd_micros) VALUES(${id},'local-operator',100,40,20)`;
    await migrateDatabase(url);
    expect((await client`SELECT budget_limit_usd_micros,reserved_open_usd_micros,pending_liability_usd_micros FROM film_budget_accounts WHERE film_id=${id}`)[0]).toMatchObject({budget_limit_usd_micros:'100',reserved_open_usd_micros:'40',pending_liability_usd_micros:'20'});
    expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(7);
  });
  await withDatabase(async(url,client)=>{
    await migrateDatabase(url,folder);const id=randomUUID();
    await client`INSERT INTO films(id,title,brief,budget_limit_usd_micros,operator_id,idempotency_key,request_hash) VALUES(${id},'Invalid FI state-3','Must block',100,'local-operator',${randomUUID()},'state-3-invalid')`;
    await client`INSERT INTO film_budget_accounts(film_id,operator_id,budget_limit_usd_micros,reserved_open_usd_micros,pending_liability_usd_micros) VALUES(${id},'local-operator',100,10,20)`;
    await expect(migrateDatabase(url)).rejects.toThrow();
    expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(3);
    expect((await client`SELECT reserved_open_usd_micros,pending_liability_usd_micros FROM film_budget_accounts WHERE film_id=${id}`)[0]).toMatchObject({reserved_open_usd_micros:'10',pending_liability_usd_micros:'20'});
  });
});

it('upgrades state-4 to state-5 (KF-001) creating asset tables and preserving existing film data',async()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'state-4-'));
  cpSync(migrationFolder,folder,{recursive:true});
  const journalFile=path.join(folder,'meta/_journal.json');
  const journal=JSON.parse(readFileSync(journalFile,'utf8')) as {entries:unknown[]};
  journal.entries=journal.entries.slice(0,4);writeFileSync(journalFile,JSON.stringify(journal));
  await withDatabase(async(url,client)=>{
    await migrateDatabase(url,folder);
    expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(4);
    expect((await client`SELECT to_regclass('public.assets') AS name`)[0].name).toBeNull();
    const id=randomUUID();
    await client`INSERT INTO films(id,title,brief,budget_limit_usd_micros,operator_id,idempotency_key,request_hash) VALUES(${id},'State-4 Film','Upgrade test',5000000,'local-operator',${randomUUID()},'state-4')`;
    await client`INSERT INTO film_budget_accounts(film_id,operator_id,budget_limit_usd_micros) VALUES(${id},'local-operator',5000000)`;
    await migrateDatabase(url);
    expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(7);
    expect((await client`SELECT to_regclass('public.assets') AS name`)[0].name).not.toBeNull();
    expect((await client`SELECT to_regclass('public.asset_reviews') AS name`)[0].name).not.toBeNull();
    expect((await client`SELECT to_regclass('public.shot_asset_selections') AS name`)[0].name).not.toBeNull();
    const [film]=await client`SELECT * FROM films WHERE id=${id}`;
    expect(film.title).toBe('State-4 Film');
  });
});

it('upgrades state-5 to state-6 (PD-001) adding EXHAUSTED state to dispatch_outbox and preserving existing outbox data', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'state-5-'));
  cpSync(migrationFolder, folder, { recursive: true });
  const journalFile = path.join(folder, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, 5);
  writeFileSync(journalFile, JSON.stringify(journal));
  await withDatabase(async (url, client) => {
    await migrateDatabase(url, folder);
    expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(5);
    const filmId = randomUUID();
    const storyId = randomUUID();
    const rateId = randomUUID();
    const attemptId = randomUUID();
    const outboxId = randomUUID();

    await client`INSERT INTO films(id, title, brief, budget_limit_usd_micros, operator_id, idempotency_key, request_hash)
      VALUES(${filmId}, 'State-5 Film', 'Upgrade test', 5000000, 'local-operator', ${randomUUID()}, 'state-5')`;
    await client`INSERT INTO film_budget_accounts(film_id, operator_id, budget_limit_usd_micros)
      VALUES(${filmId}, 'local-operator', 5000000)`;
    await client`INSERT INTO story_revisions(id, film_id, revision_no, state, content, content_hash)
      VALUES(${storyId}, ${filmId}, 1, 'APPROVED', '{}'::jsonb, 'fixture')`;
    await client`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
      VALUES(${rateId}, 'GEMINI', 'gemini-3.1-flash-image', 'IMAGE', 'FIXED_PER_REQUEST', 1000, '2026-01-01', '2027-01-01', 'fixture')`;
    await client`INSERT INTO attempts(id, film_id, story_revision_id, shot_revision_id, kind, provider, model, rate_card_snapshot_id, pricing_units, reservation_usd_micros, state)
      VALUES(${attemptId}, ${filmId}, ${storyId}, null, 'IMAGE', 'GEMINI', 'gemini-3.1-flash-image', ${rateId}, 1, 1000, 'QUEUED')`;
    await client`INSERT INTO dispatch_outbox(id, attempt_id, queue_name, payload, status, retry_count)
      VALUES(${outboxId}, ${attemptId}, 'provider-dispatch', '{}'::jsonb, 'PENDING', 2)`;

    // Apply 0005 migration
    await migrateDatabase(url);
    expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(7);

    const [outbox] = await client<{ status: string; retry_count: number; exhausted_at: unknown }[]>`
      SELECT status, retry_count, exhausted_at FROM dispatch_outbox WHERE id = ${outboxId}
    `;
    expect(outbox.status).toBe('PENDING');
    expect(outbox.retry_count).toBe(2);
    expect(outbox.exhausted_at).toBeNull();

    // Verify EXHAUSTED can now be inserted/updated
    await client`UPDATE dispatch_outbox SET status = 'EXHAUSTED', exhausted_at = now() WHERE id = ${outboxId}`;
    const [exhausted] = await client<{ status: string }[]>`SELECT status FROM dispatch_outbox WHERE id = ${outboxId}`;
    expect(exhausted.status).toBe('EXHAUSTED');
  });
});

it('upgrades state-6 to state-7 (PD-05a.2) adding execution_mode to attempts and terminal states to outbound_dispatches', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'state-6-'));
  cpSync(migrationFolder, folder, { recursive: true });
  const journalFile = path.join(folder, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, 6);
  writeFileSync(journalFile, JSON.stringify(journal));
  await withDatabase(async (url, client) => {
    await migrateDatabase(url, folder);
    expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(6);
    const filmId = randomUUID();
    const storyId = randomUUID();
    const rateId = randomUUID();
    const attemptId = randomUUID();

    await client`INSERT INTO films(id, title, brief, budget_limit_usd_micros, operator_id, idempotency_key, request_hash)
      VALUES(${filmId}, 'State-6 Film', 'Upgrade test', 5000000, 'local-operator', ${randomUUID()}, 'state-6')`;
    await client`INSERT INTO film_budget_accounts(film_id, operator_id, budget_limit_usd_micros)
      VALUES(${filmId}, 'local-operator', 5000000)`;
    await client`INSERT INTO story_revisions(id, film_id, revision_no, state, content, content_hash)
      VALUES(${storyId}, ${filmId}, 1, 'APPROVED', '{}'::jsonb, 'fixture')`;
    await client`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
      VALUES(${rateId}, 'GEMINI', 'gemini-3.1-flash-image', 'IMAGE', 'FIXED_PER_REQUEST', 1000, '2026-01-01', '2027-01-01', 'fixture')`;
    await client`INSERT INTO attempts(id, film_id, story_revision_id, shot_revision_id, kind, provider, model, rate_card_snapshot_id, pricing_units, reservation_usd_micros, state)
      VALUES(${attemptId}, ${filmId}, ${storyId}, null, 'IMAGE', 'GEMINI', 'gemini-3.1-flash-image', ${rateId}, 1, 1000, 'QUEUED')`;

    // Apply 0006 migration
    await migrateDatabase(url);
    expect(await client`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(7);

    // Existing attempts row with reservation > 0 is backfilled as 'LIVE' to preserve financial semantics
    const [att] = await client<{ execution_mode: string }[]>`SELECT execution_mode FROM attempts WHERE id = ${attemptId}`;
    expect(att.execution_mode).toBe('LIVE');

    // Subsequent inserts after migration default to 'REPLAY' when execution_mode is omitted
    const newAttemptId = randomUUID();
    await client`INSERT INTO attempts(id, film_id, story_revision_id, shot_revision_id, kind, provider, model, rate_card_snapshot_id, pricing_units, reservation_usd_micros, state)
      VALUES(${newAttemptId}, ${filmId}, ${storyId}, null, 'IMAGE', 'GEMINI', 'gemini-3.1-flash-image', ${rateId}, 1, 0, 'QUEUED')`;
    const [newAtt] = await client<{ execution_mode: string }[]>`SELECT execution_mode FROM attempts WHERE id = ${newAttemptId}`;
    expect(newAtt.execution_mode).toBe('REPLAY');

    // Outbound dispatches allows terminal states SUCCEEDED and FAILED
    const claimToken = randomUUID();
    await client`INSERT INTO outbound_dispatches(attempt_id, state, claim_token)
      VALUES(${attemptId}, 'SUCCEEDED', ${claimToken})`;
    const [disp] = await client<{ state: string }[]>`SELECT state FROM outbound_dispatches WHERE attempt_id = ${attemptId}`;
    expect(disp.state).toBe('SUCCEEDED');
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

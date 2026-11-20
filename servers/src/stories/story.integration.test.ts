import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { canonicalStory, normalizeFilm, type Expected, type StoryContent, type Storyboard, type StorySnapshot } from '@nolen/contracts';
import { createStoryApi } from '../http/story-api.js';
import { createFilm } from '../films/repository.js';
import { pgClient } from '../db/index.js';
import { migrateDatabase } from '../db/migrate.js';
import { digest, unlock } from '../auth/sessions.js';
import { hash } from './domain.js';

const api=createStoryApi();const token='test-only-operator-token-32-bytes-minimum';let cookie:string;
const input=normalizeFilm({title:'Story test',brief:'The Last Light',budgetLimitUsdMicros:'9007199254740993',durationTargetSeconds:45,aspectRatio:'9:16'});
/** Hit real Hono handlers and real PG16; no persistence or session mocks. */
function request(film:string,route:string,body?:unknown,key:string|null=randomUUID(),headers:Record<string,string>={}){
  return api.request(`http://127.0.0.1:3000/api/films/${film}/${route}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:'http://127.0.0.1:3000','Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
/** Clone active content into the explicit successor input, retaining optimistic Shot tokens. */
function successor(r:StorySnapshot):StoryContent {
  const c=structuredClone(r.content);for(const s of c.scenes.flatMap(s=>s.shots))s.expectedShotRevisionId=r.shotRevisions[s.id!].id;return c;
}
const expected=(r:StorySnapshot):Expected=>({expectedStoryRevisionId:r.id,expectedStateVersion:r.stateVersion});
async function read(id:string,revision?:string):Promise<Storyboard>{return await (await request(id,revision?`storyboard/revisions/${revision}`:'storyboard')).json() as Storyboard;}
async function setup(content=canonicalStory()){
  const key=randomUUID();const film=await createFilm(input,key,'local-operator');
  expect((await request(film.id,'storyboard/revisions',{expectedStoryRevisionId:null,expectedStateVersion:0,content})).status).toBe(201);
  return {film,key,r:(await read(film.id)).active!};
}
async function transition(id:string,r:StorySnapshot,route:string){
  expect((await request(id,`storyboard/${route}`,expected(r))).status).toBe(200);return (await read(id)).active!;
}
beforeAll(async()=>{process.env.OPERATOR_TOKEN=token;await migrateDatabase(process.env.DATABASE_URL!);cookie=`nolen_session=${await unlock(token)}`;});
afterAll(async()=>{await pgClient.end();});

it('canonical create/reload/approve, durable Film create receipt, approval evidence and immutable history',async()=>{
  const {film,key,r}=await setup();let current=r;
  const validation1=await request(film.id,'continuity/validate',expected(r),null);
  const validation2=await request(film.id,'continuity/validate',expected(r),null);
  expect(validation1.status).toBe(200);expect(await validation1.json()).toEqual(await validation2.json());
  expect((await read(film.id)).active?.stateVersion).toBe(0);
  expect((await request(film.id,'continuity/validate',{...expected(r),context:'VIDEO_DISPATCH'},null)).status).toBe(422);
  current=await transition(film.id,current,'mark-planned');current=await transition(film.id,current,'submit-review');
  const approvalKey=randomUUID();const before=expected(current);
  const response=await request(film.id,'storyboard/approve',before,approvalKey);expect(response.status).toBe(200);
  const receipt:unknown=await response.json();expect(await (await request(film.id,'storyboard/approve',before,approvalKey)).json()).toEqual(receipt);
  const board=await read(film.id);expect(board.active?.state).toBe('APPROVED');expect(board.approval?.contentHash).toBe(r.contentHash);
  expect(board.approval?.dependencyHash).toBe(board.validation?.dependencyHash);
  expect(board.approval?.waiverSetHash).toBe(hash([]));
  expect(await createFilm(input,key,'local-operator')).toEqual(film);
  for(const sql of [pgClient`UPDATE story_revisions SET content_hash='bad' WHERE id=${r.id}`,pgClient`DELETE FROM story_revision_shots WHERE story_revision_id=${r.id}`,pgClient`UPDATE story_approvals SET evidence='{}' WHERE story_revision_id=${r.id}`])await expect(sql).rejects.toThrow();
  const c=successor(board.active!);c.scenes[0].shots[0].spec.prompt='Changed after approval';
  expect((await request(film.id,'storyboard/revisions',{...expected(board.active!),content:c})).status).toBe(201);
  expect((await read(film.id)).active?.state).toBe('DRAFT');expect((await read(film.id,r.id)).revision?.contentHash).toBe(r.contentHash);
});

it('20 same-key requests replay one revision; 20 distinct keys on same expected version have one winner',async()=>{
  const film=await createFilm(input,randomUUID(),'local-operator');const key=randomUUID();const body={expectedStoryRevisionId:null,expectedStateVersion:0,content:canonicalStory()};
  const results=await Promise.all(Array.from({length:20},()=>request(film.id,'storyboard/revisions',body,key)));
  expect(results.map(r=>r.status)).toEqual(Array(20).fill(201));
  const receipts=await Promise.all(results.map(async r=>hash(await r.json())));expect(new Set(receipts).size).toBe(1);
  expect((await read(film.id)).history).toHaveLength(1);
  expect((await request(film.id,'storyboard/revisions',{...body,content:{...body.content,script:'Other'}},key)).status).toBe(409);
  const r=(await read(film.id)).active!;const next={...expected(r),content:successor(r)};
  const writes=await Promise.all(Array.from({length:20},()=>request(film.id,'storyboard/revisions',next)));
  expect(writes.filter(r=>r.status===201)).toHaveLength(1);expect(writes.filter(r=>r.status===409)).toHaveLength(19);
});

it('Bible identity edit creates affected ShotRevisions and new validation; reordering preserves stable IDs',async()=>{
  const {film,r}=await setup();const c=successor(r);c.storyBible.characters[0].description='New identity definition';
  expect((await request(film.id,'storyboard/revisions',{...expected(r),content:c})).status).toBe(201);
  const b=await read(film.id);const next=b.active!;
  for(const [id,old] of Object.entries(r.shotRevisions))expect(next.shotRevisions[id].id).not.toBe(old.id);
  const reordered=successor(next);reordered.scenes[0].shots.reverse();
  expect((await request(film.id,'storyboard/revisions',{...expected(next),content:reordered})).status).toBe(201);
  const latest=(await read(film.id)).active!;
  expect(latest.shotRevisions).toEqual(next.shotRevisions);
  expect(latest.content.scenes[0].shots.map(s=>s.id)).toEqual([...next.content.scenes[0].shots].reverse().map(s=>s.id));
});

it('waiver is dependency-bound, append-only, cannot alter approved evidence; approve/waiver race is serialized',async()=>{
  const c=canonicalStory();c.storyBible.wardrobes.push({id:'shirt',name:'Shirt',description:'White'});c.scenes[0].shots[1].spec.continuity.start.characterStates[0].wardrobeId='shirt';
  const {film,r}=await setup(c);let current=await transition(film.id,r,'mark-planned');current=await transition(film.id,current,'submit-review');
  let board=await read(film.id);const finding=board.validation!.findings.find(f=>f.waivable)!;
  expect((await request(film.id,'storyboard/approve',expected(current))).status).toBe(422);
  expect((await request(film.id,'storyboard/waivers',{...expected(current),findingFingerprint:finding.fingerprint,reason:'Producer accepts wardrobe change'})).status).toBe(200);
  current=(await read(film.id)).active!;
  const race=await Promise.all([request(film.id,'storyboard/approve',expected(current)),request(film.id,'storyboard/waivers',{...expected(current),findingFingerprint:finding.fingerprint,reason:'Duplicate waiver'})]);
  expect(race[0].status).toBe(200);expect(race[1].status).toBe(409);
  board=await read(film.id);expect(board.approval?.waiverIds).toEqual(board.waivers.map(w=>w.id));
  expect((await request(film.id,'storyboard/waivers',{...expected(board.active!),findingFingerprint:finding.fingerprint,reason:'Too late'})).status).toBe(409);
  expect((await request(film.id,'storyboard/revisions',{...expected(board.active!),content:successor(board.active!)})).status).toBe(201);
  expect((await read(film.id)).waivers).toEqual([]);
});

it('edit/approve race has one winner and direct SQL permits lifecycle but not creative mutation',async()=>{
  const {film,r}=await setup();let current=await transition(film.id,r,'mark-planned');current=await transition(film.id,current,'submit-review');
  const responses=await Promise.all([request(film.id,'storyboard/approve',expected(current)),request(film.id,'storyboard/revisions',{...expected(current),content:successor(current)})]);
  expect(responses.filter(r=>r.status<300)).toHaveLength(1);expect(responses.filter(r=>r.status===409)).toHaveLength(1);
  const other=await setup();
  await pgClient`UPDATE story_revisions SET state='PLANNED',state_version=state_version+1 WHERE id=${other.r.id}`;
  expect((await read(other.film.id)).active?.state).toBe('PLANNED');
  await expect(pgClient`UPDATE story_revisions SET content='{}' WHERE id=${other.r.id}`).rejects.toThrow();
  await expect(pgClient`UPDATE films SET active_story_revision_id=${other.r.id} WHERE id=${film.id}`).rejects.toThrow();
});

it('Story API enforces Host/Origin/auth/ownership/media/size and safe errors; fixture provenance is explicit',async()=>{
  const {film,r}=await setup();
  const rejectedHeaders:Record<string,string>[]=[{Host:'evil.test'},{Origin:''},{Origin:'http://evil.test'}];
  for(const headers of rejectedHeaders){
    const response=await request(film.id,'continuity/validate',expected(r),null,headers);expect(response.status).toBe(403);expect(response.headers.get('cache-control')).toBe('no-store');
    const body=await response.json() as {error:{requestId:string}};expect(body.error.requestId).toBeTruthy();
  }
  expect((await request(film.id,'storyboard',undefined,null,{Cookie:''})).status).toBe(401);
  const expired=(await unlock(token))!;
  await pgClient`UPDATE operator_sessions SET expires_at=now()-interval '1 hour' WHERE session_hash=${digest(expired)}`;
  expect((await request(film.id,'storyboard',undefined,null,{Cookie:`nolen_session=${expired}`})).status).toBe(401);
  const foreign=await createFilm(input,randomUUID(),'other-operator');expect((await request(foreign.id,'storyboard')).status).toBe(404);
  expect((await request('invalid-id','storyboard')).status).toBe(400);
  expect((await request(film.id,'storyboard/revisions',{...expected(r),content:canonicalStory()},null)).status).toBe(400);
  expect((await request(film.id,'continuity/validate',expected(r),null,{'Content-Type':'text/plain'})).status).toBe(415);
  expect((await request(film.id,'continuity/validate',{x:'x'.repeat(524289)},null)).status).toBe(413);
  await pgClient`ALTER TABLE operator_sessions RENAME TO operator_sessions_unavailable`;
  try {expect((await request(film.id,'storyboard')).status).toBe(503);}finally{await pgClient`ALTER TABLE operator_sessions_unavailable RENAME TO operator_sessions`;}
  const proposal=await request(film.id,'storyboard/plan-proposals',expected(r),null);expect(proposal.status).toBe(200);
  expect((await proposal.json() as {provenance:{source:string;liveInference:boolean}}).provenance).toMatchObject({source:'FIXTURE',liveInference:false});
});

it('foreign ShotRevision membership is rejected by FK; invalid references and blocking duration never approve',async()=>{
  const first=await setup(),second=await setup();
  const shotId=second.r.content.scenes[0].shots[0].id!;
  await expect(pgClient`INSERT INTO story_revision_shots(film_id,story_revision_id,scene_id,shot_id,shot_revision_id,position) VALUES(${first.film.id},${first.r.id},${first.r.content.scenes[0].id!},${shotId},${second.r.shotRevisions[shotId].id},99)`).rejects.toMatchObject({code:'23503'});
  const c=successor(first.r);c.scenes[0].shots[0].spec.locationId='foreign';
  expect((await request(first.film.id,'storyboard/revisions',{...expected(first.r),content:c})).status).toBe(422);
  expect((await read(first.film.id)).history).toHaveLength(1);
  const long=canonicalStory();long.scenes[0].shots[0].spec.durationSeconds=60;
  const invalid=await setup(long);let r=await transition(invalid.film.id,invalid.r,'mark-planned');r=await transition(invalid.film.id,r,'submit-review');
  expect((await request(invalid.film.id,'storyboard/approve',expected(r))).status).toBe(422);
});

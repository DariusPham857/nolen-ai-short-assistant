import { randomUUID } from 'node:crypto';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorSchema, attemptFinancialDtoSchema, attemptReceiptSchema, moneyProjectionSchema } from '@nolen/contracts';
import { unlock } from '../auth/sessions.js';
import { pgClient } from '../db/index.js';
import { migrateDatabase } from '../db/migrate.js';
import { createFinancialApi } from '../http/financial-api.js';
import { claimProviderSubmission, relayOne } from './outbox.js';
import { auditFinancialProjection } from './repository.js';

const token='financial-test-operator-token-at-least-32-bytes';
const api=createFinancialApi();let cookie='';
function request(route:string,method='GET',body?:unknown,key=randomUUID(),headers:Record<string,string>={}){
  return api.request(`http://127.0.0.1:3000${route}`,{method,headers:{Origin:'http://127.0.0.1:3000',Cookie:cookie,'Content-Type':'application/json','Idempotency-Key':key,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function fixture(budget='100',rate='25',rateType:'FIXED_PER_REQUEST'|'PER_SECOND'='FIXED_PER_REQUEST',approved=true,ruleSetVersion='story-approval-2',approvalDependency='fixture-dependency'){
  const filmId=randomUUID(),storyRevisionId=randomUUID(),rateCardSnapshotId=randomUUID(),validationRunId=randomUUID();
  await pgClient.begin(async tx=>{
    await tx`INSERT INTO films(id,title,brief,budget_limit_usd_micros,operator_id,idempotency_key,request_hash) VALUES(${filmId},'FI test','Financial fixture',${budget},'local-operator',${randomUUID()},'fixture')`;
    await tx`INSERT INTO film_budget_accounts(film_id,operator_id,budget_limit_usd_micros) VALUES(${filmId},'local-operator',${budget})`;
    await tx`INSERT INTO budget_limit_events(id,film_id,actor_id,prior_limit_usd_micros,new_limit_usd_micros,reason) VALUES(${randomUUID()},${filmId},'local-operator',${budget},${budget},'test baseline')`;
    await tx`INSERT INTO story_revisions(id,film_id,revision_no,state,content,content_hash) VALUES(${storyRevisionId},${filmId},1,${approved?'APPROVED':'IN_REVIEW'},'{}'::jsonb,'fixture')`;
    await tx`UPDATE films SET active_story_revision_id=${storyRevisionId},status='PLANNING' WHERE id=${filmId}`;
    if(approved){
      await tx`INSERT INTO story_validations(id,story_revision_id,context,dependency_hash,rule_set_version,findings) VALUES(${validationRunId},${storyRevisionId},'STORY_APPROVAL','fixture-dependency',${ruleSetVersion},'[]'::jsonb)`;
      await tx`INSERT INTO story_approvals(id,story_revision_id,evidence) VALUES(${randomUUID()},${storyRevisionId},${JSON.stringify({storyRevisionId,contentHash:'fixture',dependencyHash:approvalDependency,ruleSetVersion,validationRunId,waiverIds:[],waiverSetHash:'fixture-waivers',actorId:'local-operator',approvedAt:new Date().toISOString(),decision:'APPROVED'})}::jsonb)`;
    }
    await tx`INSERT INTO rate_card_snapshots(id,provider,model,operation,rate_type,unit_price_usd_micros,effective_at,expires_at,source_ref)
      VALUES(${rateCardSnapshotId},'test-provider','test-model','TTS',${rateType},${rate},'2026-01-01','2027-01-01','test-only deterministic fixture')`;
  });
  return {filmId,storyRevisionId,rateCardSnapshotId};
}
function command(f:{filmId:string;storyRevisionId:string;rateCardSnapshotId:string},units=1){return {storyRevisionId:f.storyRevisionId,shotRevisionId:null,kind:'TTS',rateCardSnapshotId:f.rateCardSnapshotId,pricingUnits:units};}

beforeAll(async()=>{process.env.OPERATOR_TOKEN=token;await migrateDatabase(process.env.DATABASE_URL!);cookie=`nolen_session=${await unlock(token)}`;});
afterAll(async()=>{await pgClient.end();});

describe('FI-001 PostgreSQL 16 financial core',()=>{
  it('serializes 20 same-key admissions into one attempt, reservation and outbox',async()=>{
    const f=await fixture('100','25');const key=randomUUID();
    const responses=await Promise.all(Array.from({length:20},()=>request(`/api/films/${f.filmId}/attempts`,'POST',command(f),key)));
    expect(responses.every(r=>r.status===201)).toBe(true);
    const bodies=await Promise.all(responses.map(async r=>attemptReceiptSchema.parse(await r.json())));
    expect(new Set(bodies.map(b=>b.attemptId)).size).toBe(1);
    expect((await pgClient`SELECT * FROM attempts WHERE film_id=${f.filmId}`)).toHaveLength(1);
    expect((await pgClient`SELECT * FROM cost_ledger_events WHERE film_id=${f.filmId}`)).toHaveLength(1);
    expect((await pgClient`SELECT o.* FROM dispatch_outbox o JOIN attempts a ON a.id=o.attempt_id WHERE a.film_id=${f.filmId}`)).toHaveLength(1);
    const budget=moneyProjectionSchema.parse(await (await request(`/api/films/${f.filmId}/budget`)).json());
    expect(budget).toMatchObject({reservedOpenUsdMicros:'25',version:1});
    expect((await request(`/api/films/${f.filmId}/attempts`,'POST',{...command(f),pricingUnits:2},key)).status).toBe(409);
  });

  it('admits only one competing reservation and leaves rejected commands write-free',async()=>{
    const f=await fixture('100','60');
    const responses=await Promise.all(Array.from({length:20},()=>request(`/api/films/${f.filmId}/attempts`,'POST',command(f),randomUUID())));
    expect(responses.filter(r=>r.status===201)).toHaveLength(1);expect(responses.filter(r=>r.status===409)).toHaveLength(19);
    expect((await pgClient`SELECT * FROM attempts WHERE film_id=${f.filmId}`)).toHaveLength(1);
    expect((await pgClient`SELECT * FROM financial_command_receipts WHERE film_id=${f.filmId}`)).toHaveLength(1);
  });

  it('blocks stale/overflow rates, unapproved stories and unsafe budget decreases',async()=>{
    const f=await fixture('100','9223372036854775807','PER_SECOND');
    expect((await request(`/api/films/${f.filmId}/budget/estimate`,'POST',{rateCardSnapshotId:f.rateCardSnapshotId,pricingUnits:2})).status).toBe(422);
    const staleRate=randomUUID();
    await pgClient`INSERT INTO rate_card_snapshots(id,provider,model,operation,rate_type,unit_price_usd_micros,effective_at,expires_at,source_ref) VALUES(${staleRate},'test-provider','old-model','TTS','FIXED_PER_REQUEST',1,'2026-01-01','2026-01-02','test stale fixture')`;
    expect((await request(`/api/films/${f.filmId}/budget/estimate`,'POST',{rateCardSnapshotId:staleRate,pricingUnits:1})).status).toBe(409);
    const unapproved=await fixture('100','10','FIXED_PER_REQUEST',false);
    expect((await request(`/api/films/${unapproved.filmId}/attempts`,'POST',command(unapproved))).status).toBe(409);
    expect((await pgClient`SELECT * FROM attempts WHERE film_id=${unapproved.filmId}`)).toHaveLength(0);
    const historical=await fixture('100','10','FIXED_PER_REQUEST',true,'story-approval-1');
    expect((await request(`/api/films/${historical.filmId}/attempts`,'POST',command(historical))).status).toBe(409);
    const staleEvidence=await fixture('100','10','FIXED_PER_REQUEST',true,'story-approval-2','stale-dependency');
    expect((await request(`/api/films/${staleEvidence.filmId}/attempts`,'POST',command(staleEvidence))).status).toBe(409);
    const superseded=await fixture('100','10');const successor=randomUUID();
    await pgClient.begin(async tx=>{await tx`INSERT INTO story_revisions(id,film_id,parent_id,revision_no,state,content,content_hash) VALUES(${successor},${superseded.filmId},${superseded.storyRevisionId},2,'DRAFT','{}'::jsonb,'successor')`;await tx`UPDATE films SET active_story_revision_id=${successor} WHERE id=${superseded.filmId}`;});
    expect((await request(`/api/films/${superseded.filmId}/attempts`,'POST',command(superseded))).status).toBe(409);
    const valid=await fixture('100','60');const admitted=attemptReceiptSchema.parse(await (await request(`/api/films/${valid.filmId}/attempts`,'POST',command(valid))).json());
    expect((await request(`/api/films/${valid.filmId}/budget`,'PATCH',{budgetLimitUsdMicros:'59',reason:'unsafe',expectedVersion:1})).status).toBe(409);
    const changed=await request(`/api/films/${valid.filmId}/budget`,'PATCH',{budgetLimitUsdMicros:'120',reason:'approved increase',expectedVersion:1});
    expect(changed.status).toBe(200);expect(moneyProjectionSchema.parse(await changed.json()).budgetLimitUsdMicros).toBe('120');
    expect(admitted.reservationUsdMicros).toBe('60');
  });

  it('posts charge/release evidence, preserves pending liabilities and replays reconciliation',async()=>{
    const f=await fixture('100','60');const admitted=attemptReceiptSchema.parse(await (await request(`/api/films/${f.filmId}/attempts`,'POST',command(f))).json());
    const pending=await request(`/api/attempts/${admitted.attemptId}/reconcile`,'POST',{billingStatus:'DISPUTED',realizedChargeUsdMicros:'20',pendingLiabilityUsdMicros:'10',evidenceRef:'deterministic-adapter:test',expectedVersion:0},randomUUID());
    expect(pending.status).toBe(200);expect(attemptFinancialDtoSchema.parse(await pending.json())).toMatchObject({billingStatus:'DISPUTED',realizedUsdMicros:'20',reservationOpenUsdMicros:'40',pendingLiabilityUsdMicros:'10',version:1});
    expect(moneyProjectionSchema.parse(await (await request(`/api/films/${f.filmId}/budget`)).json()).availableUsdMicros).toBe('40');
    const key=randomUUID();const body={billingStatus:'FINAL',realizedChargeUsdMicros:'50',pendingLiabilityUsdMicros:'0',evidenceRef:'deterministic-adapter:final',expectedVersion:1};
    const [first,second]=await Promise.all([request(`/api/attempts/${admitted.attemptId}/reconcile`,'POST',body,key),request(`/api/attempts/${admitted.attemptId}/reconcile`,'POST',body,key)]);
    expect(first.status).toBe(200);expect(second.status).toBe(200);
    const summary=moneyProjectionSchema.parse(await (await request(`/api/films/${f.filmId}/costs/summary`)).json());
    expect(summary).toMatchObject({actualSpentUsdMicros:'50',reservedOpenUsdMicros:'0',pendingLiabilityUsdMicros:'0'});
    const ledger=await (await request(`/api/films/${f.filmId}/costs/ledger`)).json() as {eventType:string}[];
    expect(ledger.map(e=>e.eventType)).toEqual(['RESERVATION_CREATED','CHARGE_POSTED','RESERVATION_RELEASED','CHARGE_POSTED','RESERVATION_RELEASED']);
    expect(await auditFinancialProjection(f.filmId)).toMatchObject({matches:true});
  });

  it('rejects stale budget and reconciliation writes but replays a committed key',async()=>{
    const f=await fixture('100','10');const admitted=attemptReceiptSchema.parse(await (await request(`/api/films/${f.filmId}/attempts`,'POST',command(f))).json());
    const budgetBodies=[{budgetLimitUsdMicros:'120',reason:'first',expectedVersion:1},{budgetLimitUsdMicros:'130',reason:'second',expectedVersion:1}];
    const budgetResults=await Promise.all(budgetBodies.map(body=>request(`/api/films/${f.filmId}/budget`,'PATCH',body,randomUUID())));
    expect(budgetResults.map(r=>r.status).sort()).toEqual([200,409]);
    const commands=[
      {key:randomUUID(),body:{billingStatus:'PARTIAL',realizedChargeUsdMicros:'4',pendingLiabilityUsdMicros:'2',evidenceRef:'first',expectedVersion:0}},
      {key:randomUUID(),body:{billingStatus:'PARTIAL',realizedChargeUsdMicros:'5',pendingLiabilityUsdMicros:'1',evidenceRef:'second',expectedVersion:0}},
    ];
    const results=await Promise.all(commands.map(item=>request(`/api/attempts/${admitted.attemptId}/reconcile`,'POST',item.body,item.key)));
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
    const winner=commands[results.findIndex(r=>r.status===200)];
    expect((await request(`/api/attempts/${admitted.attemptId}/reconcile`,'POST',winner.body,winner.key)).status).toBe(200);
  });

  it('clamps overage availability, links corrections and detects projection drift',async()=>{
    const f=await fixture('100','60');const admitted=attemptReceiptSchema.parse(await (await request(`/api/films/${f.filmId}/attempts`,'POST',command(f))).json());
    const overage={billingStatus:'FINAL',realizedChargeUsdMicros:'120',pendingLiabilityUsdMicros:'0',evidenceRef:'overage',expectedVersion:0};
    expect((await request(`/api/attempts/${admitted.attemptId}/reconcile`,'POST',overage)).status).toBe(200);
    expect(moneyProjectionSchema.parse(await (await request(`/api/films/${f.filmId}/budget`)).json())).toMatchObject({availableUsdMicros:'0',headroomUsdMicros:'-20'});
    const correction={billingStatus:'FINAL',realizedChargeUsdMicros:'110',pendingLiabilityUsdMicros:'0',evidenceRef:'invoice correction',expectedVersion:1};
    expect((await request(`/api/attempts/${admitted.attemptId}/reconcile`,'POST',correction)).status).toBe(200);
    const corrected=(await pgClient<{event_type:string;evidence:{correctionOfEventId?:string}}[]>`SELECT event_type,evidence FROM cost_ledger_events WHERE attempt_id=${admitted.attemptId} ORDER BY created_at,id`).find(event=>event.event_type==='CHARGE_CORRECTED');
    expect(corrected?.evidence.correctionOfEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await auditFinancialProjection(f.filmId)).toMatchObject({matches:true});
    await pgClient`UPDATE film_budget_accounts SET actual_spent_usd_micros=actual_spent_usd_micros+1 WHERE film_id=${f.filmId}`;
    expect(await auditFinancialProjection(f.filmId)).toMatchObject({matches:false});
  });

  it('blocks attempt admission from committing on a superseded StoryRevision during concurrent mutation', async () => {
    const f = await fixture('100', '25');
    const successor = randomUUID();
    let unblockMutation!: () => void;
    let resolveLocked!: () => void;
    const mutationLocked = new Promise<void>(resolve => { resolveLocked = resolve; });
    const mutationPromise = pgClient.begin(async tx => {
      await tx`SELECT id FROM films WHERE id=${f.filmId} FOR UPDATE`;
      resolveLocked();
      await new Promise<void>(res => { unblockMutation = res; });
      await tx`INSERT INTO story_revisions(id,film_id,parent_id,revision_no,state,content,content_hash) VALUES(${successor},${f.filmId},${f.storyRevisionId},2,'DRAFT','{}'::jsonb,'successor')`;
      await tx`UPDATE films SET active_story_revision_id=${successor} WHERE id=${f.filmId}`;
    });
    await mutationLocked;
    const admissionPromise = request(`/api/films/${f.filmId}/attempts`, 'POST', command(f));
    await new Promise(r => setTimeout(r, 100));
    unblockMutation();
    await mutationPromise;
    const response = await admissionPromise;
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('CURRENT_APPROVAL_REQUIRED');
    expect(await pgClient`SELECT * FROM attempts WHERE film_id=${f.filmId}`).toHaveLength(0);
  });

  it('guarantees consistent audit snapshot without false drift during concurrent settlement', async () => {
    const f = await fixture('100', '25');
    const admitted = attemptReceiptSchema.parse(await (await request(`/api/films/${f.filmId}/attempts`, 'POST', command(f))).json());
    const reconcileBody = { billingStatus: 'FINAL', realizedChargeUsdMicros: '20', pendingLiabilityUsdMicros: '0', evidenceRef: 'concurrent-settle', expectedVersion: 0 };
    const auditResult = await auditFinancialProjection(f.filmId, async () => {
      const res = await request(`/api/attempts/${admitted.attemptId}/reconcile`, 'POST', reconcileBody);
      expect(res.status).toBe(200);
    });
    expect(auditResult.matches).toBe(true);
    expect(auditResult.stored).toMatchObject({ actualSpentUsdMicros: '0', reservedOpenUsdMicros: '25', pendingLiabilityUsdMicros: '0' });
    expect(auditResult.expected).toMatchObject({ actualSpentUsdMicros: '0', reservedOpenUsdMicros: '25', pendingLiabilityUsdMicros: '0' });
    const finalAudit = await auditFinancialProjection(f.filmId);
    expect(finalAudit.matches).toBe(true);
    expect(finalAudit.stored).toMatchObject({ actualSpentUsdMicros: '20', reservedOpenUsdMicros: '0', pendingLiabilityUsdMicros: '0' });
  });

  it('enforces append-only audit and shared security boundary',async()=>{
    const f=await fixture();
    await expect(pgClient`UPDATE budget_limit_events SET reason='tampered' WHERE film_id=${f.filmId}`).rejects.toThrow('FI_APPEND_ONLY');
    expect((await request(`/api/films/${f.filmId}/budget`,'GET',undefined,randomUUID(),{Host:'evil.test'})).status).toBe(403);
    expect((await request(`/api/films/${f.filmId}/budget`,'PATCH',{budgetLimitUsdMicros:'101',reason:'x',expectedVersion:0},randomUUID(),{Origin:''})).status).toBe(403);
    const unauth=await api.request(`http://127.0.0.1:3000/api/films/${f.filmId}/budget`);
    expect(unauth.status).toBe(401);expect(apiErrorSchema.parse(await unauth.json()).error.requestId).toBeTruthy();
  });

  it('verifies pg-boss 10.4.2 duplicate send recovery and one worker claim',async()=>{
    const f=await fixture('100','10');const admitted=attemptReceiptSchema.parse(await (await request(`/api/films/${f.filmId}/attempts`,'POST',command(f))).json());
    await pgClient`UPDATE dispatch_outbox SET status='DELIVERED',enqueue_outcome='WORKER_CONFIRMED',delivered_at=now() WHERE attempt_id<>${admitted.attemptId}`;
    const schema=`fi_${randomUUID().replaceAll('-','').slice(0,20)}`;const boss=new PgBoss({connectionString:process.env.DATABASE_URL!,schema});boss.on('error',()=>undefined);
    await boss.start();await boss.createQueue('generation:dispatch');
    try{
      expect(await relayOne(boss,'test-relay')).toBe('DELIVERED');
      expect(await boss.getJobById('generation:dispatch',admitted.attemptId,{includeArchive:true})).toBeTruthy();
      await pgClient`UPDATE dispatch_outbox SET status='PENDING',enqueue_outcome='NOT_ATTEMPTED',boss_job_id=NULL,next_attempt_at=now() WHERE attempt_id=${admitted.attemptId}`;
      expect(await relayOne(boss,'recovery-relay')).toBe('DELIVERED');
      const claims=await Promise.all(Array.from({length:20},()=>claimProviderSubmission(admitted.attemptId)));
      expect(claims.filter(Boolean)).toHaveLength(1);
    }finally{await boss.stop({graceful:true,timeout:5000});await pgClient.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}
  });

  it('does not call null or thrown pg-boss sends delivered without independent evidence',async()=>{
    const nullFixture=await fixture('100','10');
    const nullAttempt=attemptReceiptSchema.parse(await (await request(`/api/films/${nullFixture.filmId}/attempts`,'POST',command(nullFixture))).json());
    await pgClient`UPDATE dispatch_outbox SET status='DELIVERED',enqueue_outcome='WORKER_CONFIRMED',delivered_at=now() WHERE attempt_id<>${nullAttempt.attemptId}`;
    expect(await relayOne({send:async()=>null,getJobById:async()=>null},'null-relay')).toBe('RETRY');
    expect((await pgClient<{status:string;enqueue_outcome:string}[]>`SELECT status,enqueue_outcome FROM dispatch_outbox WHERE attempt_id=${nullAttempt.attemptId}`)[0]).toMatchObject({status:'PENDING',enqueue_outcome:'NULL_UNVERIFIED'});

    const thrownFixture=await fixture('100','10');
    const thrownAttempt=attemptReceiptSchema.parse(await (await request(`/api/films/${thrownFixture.filmId}/attempts`,'POST',command(thrownFixture))).json());
    await pgClient`UPDATE dispatch_outbox SET status='DELIVERED',enqueue_outcome='WORKER_CONFIRMED',delivered_at=now() WHERE attempt_id<>${thrownAttempt.attemptId}`;
    expect(await relayOne({send:async()=>{throw new Error('ambiguous transport failure');},getJobById:async()=>null},'throw-relay')).toBe('RETRY');
    expect((await pgClient<{status:string;enqueue_outcome:string}[]>`SELECT status,enqueue_outcome FROM dispatch_outbox WHERE attempt_id=${thrownAttempt.attemptId}`)[0]).toMatchObject({status:'PENDING',enqueue_outcome:'UNKNOWN_ENQUEUE_OUTCOME'});
  });
});


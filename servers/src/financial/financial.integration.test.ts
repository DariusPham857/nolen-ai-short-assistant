import { createHash, randomUUID } from 'node:crypto';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorSchema, attemptFinancialDtoSchema, attemptReceiptSchema, moneyProjectionSchema, type GenerationRequest } from '@nolen/contracts';
import { unlock } from '../auth/sessions.js';
import { pgClient } from '../db/index.js';
import { migrateDatabase } from '../db/migrate.js';
import { createFinancialApi } from '../http/financial-api.js';
import { claimProviderSubmission, relayOne } from './outbox.js';
import { auditFinancialProjection } from './repository.js';
import { canonicalizePayload } from '../dispatch/service.js';
import { fakeAssetProducer } from '../assets/repository.js';
import { seedBaselineRateCards } from '../db/seed-rate-cards.js';

const token='financial-test-operator-token-at-least-32-bytes';
const api=createFinancialApi();let cookie='';
async function request(route:string,method='GET',body?:unknown,key=randomUUID(),headers:Record<string,string>={}): Promise<Response> {
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
      VALUES(${rateCardSnapshotId},'LOCAL_PAN_ZOOM','test-model','TTS',${rateType},${rate},'2026-01-01','2027-01-01','test-only deterministic fixture')`;
  });
  return {filmId,storyRevisionId,rateCardSnapshotId};
}
function command(
  f: { filmId: string; storyRevisionId: string; rateCardSnapshotId: string },
  units = 1,
  executionMode: 'LIVE' | 'REPLAY' = 'LIVE',
) {
  return {
    storyRevisionId: f.storyRevisionId,
    shotRevisionId: null,
    kind: 'TTS' as const,
    rateCardSnapshotId: f.rateCardSnapshotId,
    pricingUnits: units,
    executionMode,
  };
}

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
    let unblockMutation: (() => void) | undefined;
    let resolveLocked!: () => void;
    let mutationPid = 0;
    const mutationLocked = new Promise<void>(resolve => { resolveLocked = resolve; });
    const mutationPromise = pgClient.begin(async tx => {
      const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      mutationPid = pid;
      await tx`SELECT id FROM films WHERE id=${f.filmId} FOR UPDATE`;
      resolveLocked();
      await new Promise<void>(res => { unblockMutation = res; });
      await tx`INSERT INTO story_revisions(id,film_id,parent_id,revision_no,state,content,content_hash) VALUES(${successor},${f.filmId},${f.storyRevisionId},2,'DRAFT','{}'::jsonb,'successor')`;
      await tx`UPDATE films SET active_story_revision_id=${successor} WHERE id=${f.filmId}`;
    });
    try {
      await Promise.race([mutationLocked, mutationPromise]);
      let admissionSettled = false;
      const admissionPromise = request(`/api/films/${f.filmId}/attempts`, 'POST', command(f))
        .finally(() => { admissionSettled = true; });

      let isBlocked = false;
      for (let i = 0; i < 200; i++) {
        if (admissionSettled) {
          throw new Error('Admission completed before being blocked on the film row lock');
        }
        const blockers = await pgClient<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity WHERE ${mutationPid} = ANY(pg_blocking_pids(pid))
        `;
        if (blockers.length > 0) {
          isBlocked = true;
          break;
        }
        await new Promise(r => setTimeout(r, 20));
      }
      expect(isBlocked).toBe(true);
      expect(admissionSettled).toBe(false);

      unblockMutation?.();
      await mutationPromise;
      const response = await admissionPromise;
      expect(response.status).toBe(409);
      expect((await response.json() as { error: { code: string } }).error.code).toBe('CURRENT_APPROVAL_REQUIRED');
      expect(await pgClient`SELECT * FROM attempts WHERE film_id=${f.filmId}`).toHaveLength(0);
    } finally {
      unblockMutation?.();
      await mutationPromise.catch(() => {});
    }
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
    const [outboxRow] = await pgClient<{ queue_name: string }[]>`SELECT queue_name FROM dispatch_outbox WHERE attempt_id=${admitted.attemptId}`;
    const queueName = outboxRow.queue_name;
    await boss.start();await boss.createQueue(queueName);
    try{
      expect(await relayOne(boss,'test-relay')).toBe('DELIVERED');
      expect(await boss.getJobById(queueName,admitted.attemptId,{includeArchive:true})).toBeTruthy();
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

  // Helper to establish a film in genuine deficit/overage (headroom < 0) via valid settlement
  async function createOverageFilmFixture() {
    const f = await fixture('100', '60');
    const admitted = attemptReceiptSchema.parse(
      await (await request(`/api/films/${f.filmId}/attempts`, 'POST', {
        ...command(f, 1),
        executionMode: 'LIVE',
      })).json()
    );
    expect(admitted.billingStatus).toBe('PENDING');
    const overage = {
      billingStatus: 'FINAL',
      realizedChargeUsdMicros: '120',
      pendingLiabilityUsdMicros: '0',
      evidenceRef: 'overage-settlement',
      expectedVersion: 0,
    };
    const settleRes = await request(`/api/attempts/${admitted.attemptId}/reconcile`, 'POST', overage);
    expect(settleRes.status).toBe(200);

    const budget = moneyProjectionSchema.parse(await (await request(`/api/films/${f.filmId}/budget`)).json());
    expect(BigInt(budget.headroomUsdMicros)).toBeLessThan(0n);
    expect(budget.headroomUsdMicros).toBe('-20');
    return f;
  }

  it('PD-AT-12a: rejects REPLAY under genuine negative headroom when StoryRevision is unapproved', async () => {
    const f = await createOverageFilmFixture();
    const unapprovedStoryId = randomUUID();
    await pgClient`
      INSERT INTO story_revisions(id, film_id, revision_no, state, content, content_hash)
      VALUES(${unapprovedStoryId}, ${f.filmId}, 2, 'IN_REVIEW', '{}'::jsonb, 'unapproved-hash')
    `;
    await pgClient`UPDATE films SET active_story_revision_id = ${unapprovedStoryId} WHERE id = ${f.filmId}`;

    const res = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: unapprovedStoryId,
      shotRevisionId: null,
      kind: 'TTS',
      rateCardSnapshotId: f.rateCardSnapshotId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: { code: string } };
    expect(body.error?.code).toBe('CURRENT_APPROVAL_REQUIRED');
  });

  it('PD-AT-12b: rejects REPLAY under genuine negative headroom when VIDEO attempt lacks approved keyframe', async () => {
    const f = await createOverageFilmFixture();
    const sceneId = randomUUID();
    const shotRevisionId = randomUUID();
    const shotId = randomUUID();
    const videoRateCardId = randomUUID();
    await pgClient.begin(async tx => {
      await tx`INSERT INTO scenes(id, film_id) VALUES(${sceneId}, ${f.filmId})`;
      await tx`INSERT INTO story_revision_scenes(film_id, story_revision_id, scene_id, position)
        VALUES(${f.filmId}, ${f.storyRevisionId}, ${sceneId}, 1)`;
      await tx`INSERT INTO shots(id, film_id) VALUES(${shotId}, ${f.filmId})`;
      await tx`INSERT INTO shot_revisions(id, film_id, shot_id, spec, dependency_hash, policy)
        VALUES(${shotRevisionId}, ${f.filmId}, ${shotId}, '{"prompt":"Hero walking"}'::jsonb, 'dep-hash-1', '{"effectiveRequirement":"REQUIRED"}'::jsonb)`;
      await tx`INSERT INTO story_revision_shots(film_id, story_revision_id, scene_id, shot_id, shot_revision_id, position)
        VALUES(${f.filmId}, ${f.storyRevisionId}, ${sceneId}, ${shotId}, ${shotRevisionId}, 1)`;
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${videoRateCardId}, 'RUNWAY', 'gen4_turbo', 'VIDEO', 'FIXED_PER_REQUEST', 25, '2026-01-01', '2027-01-01', 'test fixture')`;
    });

    const res = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: videoRateCardId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: { code: string } };
    expect(body.error?.code).toBe('KEYFRAME_APPROVAL_REQUIRED');
  });

  it('PD-AT-12c: admits REPLAY under genuine negative headroom with zero reservation and zero ledger events', async () => {
    const f = await createOverageFilmFixture();
    const initialEvents = await pgClient`SELECT count(*) FROM cost_ledger_events WHERE film_id = ${f.filmId}`;
    const initialCount = Number(initialEvents[0].count);

    const res = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      ...command(f, 1),
      executionMode: 'REPLAY',
    });
    expect(res.status).toBe(201);
    const admitted = attemptReceiptSchema.parse(await res.json());
    expect(admitted.reservationUsdMicros).toBe('0');
    expect(admitted.billingStatus).toBe('FINAL');

    // Budget account reservation must NOT change
    const budget = moneyProjectionSchema.parse(await (await request(`/api/films/${f.filmId}/budget`)).json());
    expect(budget.reservedOpenUsdMicros).toBe('0');
    expect(budget.headroomUsdMicros).toBe('-20');

    // Cost ledger events must NOT change
    const afterEvents = await pgClient`SELECT count(*) FROM cost_ledger_events WHERE film_id = ${f.filmId}`;
    expect(Number(afterEvents[0].count)).toBe(initialCount);

    // attempt_financial_state: reservation_open = '0', billing_status = 'FINAL' (consistent with receipt)
    const [attemptFin] = await pgClient<{ reservation_open_usd_micros: string; billing_status: string }[]>`
      SELECT reservation_open_usd_micros, billing_status FROM attempt_financial_state WHERE attempt_id = ${admitted.attemptId}
    `;
    expect(attemptFin.reservation_open_usd_micros).toBe('0');
    expect(attemptFin.billing_status).toBe('FINAL');
    expect(attemptFin.billing_status).toBe(admitted.billingStatus);
  });

  it('PD-AT-13: freezes deterministic default fixture identity and 64-char sha256 request snapshot into dispatch_outbox.payload at admission', async () => {
    const f = await fixture('100', '25');
    const res = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      ...command(f, 1),
      executionMode: 'REPLAY',
    });
    expect(res.status).toBe(201);
    const admitted = attemptReceiptSchema.parse(await res.json());
    expect(admitted.billingStatus).toBe('FINAL');

    // 1. Inspect attempts table in PostgreSQL: execution_mode must be 'REPLAY' strictly
    const [attRow] = await pgClient<{ execution_mode: string }[]>`
      SELECT execution_mode FROM attempts WHERE id = ${admitted.attemptId}
    `;
    expect(attRow).toBeDefined();
    expect(attRow.execution_mode).toBe('REPLAY');

    // 2. Inspect dispatch_outbox table in PostgreSQL: payload must have frozen request & requestFingerprint
    interface OutboxPayload {
      request: GenerationRequest;
      requestFingerprint: string;
    }
    const [outboxRow] = await pgClient<{ payload: OutboxPayload }[]>`
      SELECT payload FROM dispatch_outbox WHERE attempt_id = ${admitted.attemptId}
    `;
    expect(outboxRow).toBeDefined();
    expect(outboxRow.payload.request).toBeDefined();
    expect(outboxRow.payload.request.attemptId).toBe(admitted.attemptId);
    expect(outboxRow.payload.request.executionMode).toBe('REPLAY');
    expect(outboxRow.payload.request.prompt).toBe('Financial fixture');
    expect(outboxRow.payload.request.provider).toBe('LOCAL_PAN_ZOOM');
    expect(outboxRow.payload.request.fixtureId).toBeDefined();
    expect(outboxRow.payload.request.fixturePackVersion).toBe('v1');

    // Strict SHA-256 digest equality with canonical request payload
    const expectedDigest = createHash('sha256')
      .update(canonicalizePayload(outboxRow.payload.request))
      .digest('hex');
    expect(outboxRow.payload.requestFingerprint).toBe(expectedDigest);
    expect(outboxRow.payload.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);

    // Verify distinct request payloads produce distinct fingerprints
    const res2 = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      ...command(f, 2),
      executionMode: 'REPLAY',
    });
    expect(res2.status).toBe(201);
    const admitted2 = attemptReceiptSchema.parse(await res2.json());
    const [outboxRow2] = await pgClient<{ payload: OutboxPayload }[]>`
      SELECT payload FROM dispatch_outbox WHERE attempt_id = ${admitted2.attemptId}
    `;
    expect(outboxRow2.payload.requestFingerprint).not.toBe(outboxRow.payload.requestFingerprint);
    const expectedDigest2 = createHash('sha256')
      .update(canonicalizePayload(outboxRow2.payload.request))
      .digest('hex');
    expect(outboxRow2.payload.requestFingerprint).toBe(expectedDigest2);
  });

  it('PD-AT-11: strictly forbids reconcileAttempt on REPLAY attempts with 409 REPLAY_ATTEMPT_NON_RECONCILABLE', async () => {
    const f = await fixture('100', '25');
    const replayAdmitRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      ...command(f, 1),
      executionMode: 'REPLAY',
    });
    expect(replayAdmitRes.status).toBe(201);
    const replayReceipt = attemptReceiptSchema.parse(await replayAdmitRes.json());
    expect(replayReceipt.billingStatus).toBe('FINAL');

    const reconcileRes = await request(`/api/attempts/${replayReceipt.attemptId}/reconcile`, 'POST', {
      billingStatus: 'FINAL',
      realizedChargeUsdMicros: '10',
      pendingLiabilityUsdMicros: '0',
      evidenceRef: 'invalid-replay-reconciliation',
      expectedVersion: 0,
    });
    expect(reconcileRes.status).toBe(409);
    const body = await reconcileRes.json() as { error?: { code: string } };
    expect(body.error?.code).toBe('REPLAY_ATTEMPT_NON_RECONCILABLE');
  });

  it('PD-AT-13b: extracts authoritative prompt from ShotRevision or Film brief, and fails closed with 422 on unsupported provider or empty prompt', async () => {
    const f = await fixture('100', '25');

    // 1. Unsupported provider fails closed with 422 UNSUPPORTED_PROVIDER
    const badRateId = randomUUID();
    await pgClient`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
      VALUES(${badRateId}, 'UNSUPPORTED_AI_VENDOR', 'v1', 'TTS', 'FIXED_PER_REQUEST', 10, '2026-01-01', '2027-01-01', 'test fixture')`;
    const resBadProv = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      ...command(f, 1),
      rateCardSnapshotId: badRateId,
    });
    expect(resBadProv.status).toBe(422);
    const bodyBadProv = await resBadProv.json() as { error?: { code: string } };
    expect(bodyBadProv.error?.code).toBe('UNSUPPORTED_PROVIDER');

    // 2. Authoritative prompt from ShotRevision
    const sceneId = randomUUID();
    const shotRevisionId = randomUUID();
    const shotId = randomUUID();
    await pgClient.begin(async tx => {
      await tx`INSERT INTO scenes(id, film_id) VALUES(${sceneId}, ${f.filmId})`;
      await tx`INSERT INTO story_revision_scenes(film_id, story_revision_id, scene_id, position)
        VALUES(${f.filmId}, ${f.storyRevisionId}, ${sceneId}, 1)`;
      await tx`INSERT INTO shots(id, film_id) VALUES(${shotId}, ${f.filmId})`;
      await tx`INSERT INTO shot_revisions(id, film_id, shot_id, spec, dependency_hash, policy)
        VALUES(${shotRevisionId}, ${f.filmId}, ${shotId}, '{"prompt":"Authoritative character prompt"}'::jsonb, 'dep-hash-2', '{"effectiveRequirement":"OPTIONAL"}'::jsonb)`;
      await tx`INSERT INTO story_revision_shots(film_id, story_revision_id, scene_id, shot_id, shot_revision_id, position)
        VALUES(${f.filmId}, ${f.storyRevisionId}, ${sceneId}, ${shotId}, ${shotRevisionId}, 1)`;
    });

    const resShot = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId,
      kind: 'TTS',
      rateCardSnapshotId: f.rateCardSnapshotId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });
    expect(resShot.status).toBe(201);
    const shotAdmitted = attemptReceiptSchema.parse(await resShot.json());
    const [shotOutbox] = await pgClient<{ payload: { request: GenerationRequest } }[]>`
      SELECT payload FROM dispatch_outbox WHERE attempt_id = ${shotAdmitted.attemptId}
    `;
    expect(shotOutbox.payload.request.prompt).toBe('Authoritative character prompt');

    // 3. Empty prompt fails closed with 422 EMPTY_PROMPT
    const emptyShotRevId = randomUUID();
    const emptyShotId = randomUUID();
    await pgClient.begin(async tx => {
      await tx`INSERT INTO shots(id, film_id) VALUES(${emptyShotId}, ${f.filmId})`;
      await tx`INSERT INTO shot_revisions(id, film_id, shot_id, spec, dependency_hash, policy)
        VALUES(${emptyShotRevId}, ${f.filmId}, ${emptyShotId}, '{"prompt":"   "}'::jsonb, 'dep-hash-3', '{"effectiveRequirement":"OPTIONAL"}'::jsonb)`;
      await tx`INSERT INTO story_revision_shots(film_id, story_revision_id, scene_id, shot_id, shot_revision_id, position)
        VALUES(${f.filmId}, ${f.storyRevisionId}, ${sceneId}, ${emptyShotId}, ${emptyShotRevId}, 2)`;
    });
    const resEmpty = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: emptyShotRevId,
      kind: 'TTS',
      rateCardSnapshotId: f.rateCardSnapshotId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });
    expect(resEmpty.status).toBe(422);
    const bodyEmpty = await resEmpty.json() as { error?: { code: string } };
    expect(bodyEmpty.error?.code).toBe('EMPTY_PROMPT');
  });

  it('BLOCK 2: rejects admission when fixturePackVersion contains directory traversal with 422', async () => {
    const f = await fixture('100', '25');
    const traversalPayloads = [
      'x/../replay-pack-v1',
      '../v1',
      '/v1',
      'v1/..',
    ];

    for (const fixturePackVersion of traversalPayloads) {
      const res = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
        ...command(f, 1, 'REPLAY'),
        fixturePackVersion,
      });
      expect(res.status).toBe(422);
    }
  });

  it('EP-05: GET /api/rate-cards requires operator and is strictly read-only', async () => {
    // 1. Without operator cookie -> 401
    const unauthed = await api.request('http://127.0.0.1:3000/api/rate-cards', {
      method: 'GET',
      headers: { Origin: 'http://127.0.0.1:3000' },
    });
    expect(unauthed.status).toBe(401);

    // 2. Count existing snapshots before
    const [countBefore] = await pgClient<{ count: string }[]>`SELECT count(*)::text FROM rate_card_snapshots`;

    // 3. Authenticated request -> 200 array
    const authed = await request('/api/rate-cards', 'GET');
    expect(authed.status).toBe(200);
    const cards = await authed.json() as { id: string; provider: string; model: string; operation: string; rateType: string; unitPriceUsdMicros: string }[];
    expect(Array.isArray(cards)).toBe(true);

    // 4. Verify strictly read-only: count after MUST match count before
    const [countAfter] = await pgClient<{ count: string }[]>`SELECT count(*)::text FROM rate_card_snapshots`;
    expect(countAfter.count).toBe(countBefore.count);
  });

  it('EP-05: server-side keyframe gating blocks OPTIONAL shot video attempt when no keyframe approved', async () => {
    const f = await fixture('100', '25');
    const shotId = randomUUID();
    const shotRevisionId = randomUUID();
    const sceneId = randomUUID();
    const videoRateCardId = randomUUID();

    await pgClient.begin(async tx => {
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${videoRateCardId}, 'RUNWAY', 'gen4_turbo', 'VIDEO', 'PER_SECOND', 50000, '2026-01-01', '2027-01-01', 'test runway rate')`;
      await tx`INSERT INTO scenes(id, film_id) VALUES(${sceneId}, ${f.filmId})`;
      await tx`INSERT INTO story_revision_scenes(film_id, story_revision_id, scene_id, position)
        VALUES(${f.filmId}, ${f.storyRevisionId}, ${sceneId}, 1)`;
      await tx`INSERT INTO shots(id, film_id) VALUES(${shotId}, ${f.filmId})`;
      await tx`INSERT INTO shot_revisions(id, film_id, shot_id, spec, dependency_hash, policy)
        VALUES(${shotRevisionId}, ${f.filmId}, ${shotId}, '{"prompt":"A cinematic wide shot"}'::jsonb, 'dep-hash-opt', '{"effectiveRequirement":"OPTIONAL"}'::jsonb)`;
      await tx`INSERT INTO story_revision_shots(film_id, story_revision_id, scene_id, shot_id, shot_revision_id, position)
        VALUES(${f.filmId}, ${f.storyRevisionId}, ${sceneId}, ${shotId}, ${shotRevisionId}, 1)`;
    });

    const res = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: videoRateCardId,
      pricingUnits: 5,
      executionMode: 'REPLAY',
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: { code: string } };
    expect(body.error?.code).toBe('KEYFRAME_APPROVAL_REQUIRED');
  });

  it('EP-05: LIVE attempt with MODELED_ONLY rate card is rejected with 422 UNVERIFIED_LIVE_RATE_CARD', async () => {
    const f = await fixture('100', '25');
    const modeledRateCardId = randomUUID();

    await pgClient`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
      VALUES(${modeledRateCardId}, 'LOCAL_PAN_ZOOM', 'pan-zoom', 'TTS', 'FIXED_PER_REQUEST', 25, '2026-01-01', '2027-01-01', 'MODELED_ONLY (PRD illustrative example)')`;

    const res = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: null,
      kind: 'TTS',
      rateCardSnapshotId: modeledRateCardId,
      pricingUnits: 1,
      executionMode: 'LIVE',
    });
    expect(res.status).toBe(422);
    const body = await res.json() as { error?: { code: string } };
    expect(body.error?.code).toBe('UNVERIFIED_LIVE_RATE_CARD');
  });

  it('EP-05: VIDEO admission freezes approved keyframeAssetId into outbox snapshot and survives subsequent selection changes', async () => {
    const f = await fixture('100', '25');
    const shotId = randomUUID();
    const shotRevisionId = randomUUID();
    const sceneId = randomUUID();
    const videoRateCardId = randomUUID();
    const imageRateCardId = randomUUID();

    await pgClient.begin(async tx => {
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${videoRateCardId}, 'RUNWAY', 'gen4_turbo', 'VIDEO', 'PER_SECOND', 50000, '2026-01-01', '2027-01-01', 'test runway rate')`;
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${imageRateCardId}, 'GEMINI', 'gemini-3.1-flash-image', 'IMAGE', 'FIXED_PER_REQUEST', 20000, '2026-01-01', '2027-01-01', 'test gemini rate')`;
      await tx`INSERT INTO scenes(id, film_id) VALUES(${sceneId}, ${f.filmId})`;
      await tx`INSERT INTO story_revision_scenes(film_id, story_revision_id, scene_id, position)
        VALUES(${f.filmId}, ${f.storyRevisionId}, ${sceneId}, 1)`;
      await tx`INSERT INTO shots(id, film_id) VALUES(${shotId}, ${f.filmId})`;
      await tx`INSERT INTO shot_revisions(id, film_id, shot_id, spec, dependency_hash, policy)
        VALUES(${shotRevisionId}, ${f.filmId}, ${shotId}, '{"prompt":"A cinematic wide shot"}'::jsonb, 'dep-hash-opt', '{"effectiveRequirement":"OPTIONAL"}'::jsonb)`;
      await tx`INSERT INTO story_revision_shots(film_id, story_revision_id, scene_id, shot_id, shot_revision_id, position)
        VALUES(${f.filmId}, ${f.storyRevisionId}, ${sceneId}, ${shotId}, ${shotRevisionId}, 1)`;
    });

    // 1. Produce Keyframe A on disk and approve it
    const attemptAId = randomUUID();
    await pgClient`INSERT INTO attempts(id, film_id, story_revision_id, shot_revision_id, kind, provider, model, rate_card_snapshot_id, pricing_units, reservation_usd_micros, state, execution_mode)
      VALUES(${attemptAId}, ${f.filmId}, ${f.storyRevisionId}, ${shotRevisionId}, 'IMAGE', 'google', 'gemini-3.1-flash-image', ${imageRateCardId}, 1, 0, 'SUCCEEDED', 'REPLAY')`;
    const assetA = await fakeAssetProducer({
      filmId: f.filmId,
      attemptId: attemptAId,
      shotRevisionId,
      kind: 'IMAGE',
    });
    await pgClient`INSERT INTO shot_asset_selections(film_id, story_revision_id, shot_id, shot_revision_id, kind, asset_id, selected_by)
      VALUES(${f.filmId}, ${f.storyRevisionId}, ${shotId}, ${shotRevisionId}, 'IMAGE', ${assetA.id}, 'operator')`;
    await pgClient`INSERT INTO asset_reviews(id, film_id, asset_id, shot_revision_id, decision, actor_id, reason)
      VALUES(${randomUUID()}, ${f.filmId}, ${assetA.id}, ${shotRevisionId}, 'APPROVED', 'operator', 'Approved keyframe A')`;

    // 2. Admit VIDEO attempt
    const res = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: videoRateCardId,
      pricingUnits: 5,
      executionMode: 'REPLAY',
    }, randomUUID());
    expect(res.status).toBe(201);
    const { attemptId: videoAttemptId } = await res.json() as { attemptId: string };

    // 3. Inspect dispatch_outbox payload: keyframeAssetId MUST equal assetA.id
    const [outboxRow] = await pgClient<{ payload: { request: { keyframeAssetId?: string } } }[]>`
      SELECT payload FROM dispatch_outbox WHERE attempt_id = ${videoAttemptId}
    `;
    expect(outboxRow.payload.request.keyframeAssetId).toBe(assetA.id);

    // 4. Produce Keyframe B on disk and switch active selection
    const attemptBId = randomUUID();
    await pgClient`INSERT INTO attempts(id, film_id, story_revision_id, shot_revision_id, kind, provider, model, rate_card_snapshot_id, pricing_units, reservation_usd_micros, state, execution_mode)
      VALUES(${attemptBId}, ${f.filmId}, ${f.storyRevisionId}, ${shotRevisionId}, 'IMAGE', 'google', 'gemini-3.1-flash-image', ${imageRateCardId}, 1, 0, 'SUCCEEDED', 'REPLAY')`;
    const assetB = await fakeAssetProducer({
      filmId: f.filmId,
      attemptId: attemptBId,
      shotRevisionId,
      kind: 'IMAGE',
    });
    await pgClient`
      UPDATE shot_asset_selections
      SET asset_id = ${assetB.id}
      WHERE film_id = ${f.filmId}
        AND story_revision_id = ${f.storyRevisionId}
        AND shot_id = ${shotId}
        AND kind = 'IMAGE'
    `;

    // 5. Re-inspect dispatch_outbox payload: keyframeAssetId MUST STILL BE assetA.id (frozen snapshot)
    const [outboxRowAfter] = await pgClient<{ payload: { request: { keyframeAssetId?: string } } }[]>`
      SELECT payload FROM dispatch_outbox WHERE attempt_id = ${videoAttemptId}
    `;
    expect(outboxRowAfter.payload.request.keyframeAssetId).toBe(assetA.id);
  });

  it('EP-05: bootstrap rate cards seed provisions all 4 REPLAY providers idempotently for GET /api/rate-cards', async () => {
    await seedBaselineRateCards(pgClient);
    // Calling a second time must remain idempotent
    await seedBaselineRateCards(pgClient);

    const res = await request('/api/rate-cards', 'GET');
    expect(res.status).toBe(200);
    const cards = await res.json() as { provider: string; operation: string; sourceRef: string }[];
    expect(cards.some(c => c.provider === 'GEMINI' && c.operation === 'IMAGE')).toBe(true);
    expect(cards.some(c => c.provider === 'RUNWAY' && c.operation === 'VIDEO')).toBe(true);
    expect(cards.some(c => c.provider === 'FAL_KLING' && c.operation === 'VIDEO')).toBe(true);
    expect(cards.some(c => c.provider === 'LOCAL_PAN_ZOOM' && c.operation === 'VIDEO')).toBe(true);
  });
});


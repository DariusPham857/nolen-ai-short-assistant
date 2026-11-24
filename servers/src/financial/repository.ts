import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type postgres from 'postgres';
import type { CreateAttempt, EstimateAttempt, ProviderKind, ReconcileAttempt, UpdateBudget } from '@nolen/contracts';
import { pgClient } from '../db/index.js';
import { ApiFailure } from '../http/errors.js';
import { RULESET } from '../stories/domain.js';
import { storage, type AssetCategory } from '../lib/storage.js';
import { add, assertAdmission, estimate, projection, subtract, type Projection, type Rate } from './domain.js';
import { freezeGenerationRequestSnapshot, resolveDefaultFixture } from '../dispatch/service.js';

type Tx = postgres.TransactionSql;
type AccountRow = {
  film_id: string; operator_id: string; budget_limit_usd_micros: string;
  actual_spent_usd_micros: string; reserved_open_usd_micros: string;
  pending_liability_usd_micros: string; version: number;
};
type RateRow = {
  id: string; provider: string; model: string; operation: string;
  rate_type: Rate['rateType']; unit_price_usd_micros: string;
  provider_maximum_usd_micros: string | null; effective_at: Date|string; expires_at: Date|string;
};
type FinancialRow = {
  attempt_id: string; film_id: string; state: string; rate_card_snapshot_id: string;
  reservation_usd_micros: string;
  billing_status: 'PENDING'|'PARTIAL'|'FINAL'|'DISPUTED'; reservation_open_usd_micros: string;
  realized_usd_micros: string; pending_liability_usd_micros: string;
  version: number;
  outbox_status: 'PENDING'|'DELIVERING'|'DELIVERED';
  enqueue_outcome: 'NOT_ATTEMPTED'|'JOB_ID'|'NULL_UNVERIFIED'|'UNKNOWN_ENQUEUE_OUTCOME'|'WORKER_CONFIRMED';
};

export type AttemptReceipt = {
  attemptId: string; filmId: string; state: 'QUEUED'; billingStatus: 'PENDING' | 'FINAL';
  reservationUsdMicros: string; outboxStatus: 'PENDING';
};

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function accountProjection(row: AccountRow): Projection {
  return { budgetLimitUsdMicros: BigInt(row.budget_limit_usd_micros), actualSpentUsdMicros: BigInt(row.actual_spent_usd_micros),
    reservedOpenUsdMicros: BigInt(row.reserved_open_usd_micros), pendingLiabilityUsdMicros: BigInt(row.pending_liability_usd_micros) };
}

export function resolveOutboxQueue(kind: string, executionMode: 'LIVE' | 'REPLAY'): string {
  const prefix = executionMode === 'REPLAY' ? 'replay' : 'live';
  if (kind === 'TTS') return `${prefix}:tts:dispatch`;
  if (kind === 'ASSEMBLY') return `${prefix}:assembly:dispatch`;
  return `${prefix}:generation:dispatch`;
}

function projectionDto(row: AccountRow) {
  const value = projection(accountProjection(row));
  return { ...Object.fromEntries(Object.entries(value).map(([key,item]) => [key, typeof item === 'bigint' ? item.toString() : item])), version:row.version };
}

function rateValue(row: RateRow): Rate {
  return { id:row.id, rateType:row.rate_type, unitPriceUsdMicros:BigInt(row.unit_price_usd_micros),
    providerMaximumUsdMicros:row.provider_maximum_usd_micros===null?null:BigInt(row.provider_maximum_usd_micros),
    effectiveAt:new Date(row.effective_at), expiresAt:new Date(row.expires_at) };
}

async function ownedAccount(tx: Tx, filmId: string, operatorId: string, lock: boolean): Promise<AccountRow> {
  const rows = lock
    ? await tx<AccountRow[]>`SELECT a.* FROM film_budget_accounts a JOIN films f ON f.id=a.film_id WHERE a.film_id=${filmId} AND f.operator_id=${operatorId} FOR UPDATE OF a`
    : await tx<AccountRow[]>`SELECT a.* FROM film_budget_accounts a JOIN films f ON f.id=a.film_id WHERE a.film_id=${filmId} AND f.operator_id=${operatorId}`;
  if (!rows[0]) throw new ApiFailure(404,'FILM_NOT_FOUND','Film not found');
  return rows[0];
}

async function loadRate(tx: Tx, id: string): Promise<RateRow> {
  const [row] = await tx<RateRow[]>`SELECT * FROM rate_card_snapshots WHERE id=${id}`;
  if (!row) throw new ApiFailure(422,'RATE_CARD_REQUIRED','Select a supported rate-card snapshot');
  return row;
}

async function receipt<T>(tx: Tx, filmId:string, operatorId:string, key:string, command:string, requestHash:string):Promise<T|null> {
  const [row] = await tx<{command:string;request_hash:string;response:T}[]>`SELECT command,request_hash,response FROM financial_command_receipts WHERE film_id=${filmId} AND operator_id=${operatorId} AND key=${key}`;
  if (!row) return null;
  if (row.command!==command || row.request_hash!==requestHash) throw new ApiFailure(409,'IDEMPOTENCY_CONFLICT','Key was used for another financial command');
  return row.response;
}

async function saveReceipt(tx:Tx,filmId:string,operatorId:string,key:string,command:string,requestHash:string,response:unknown) {
  await tx`INSERT INTO financial_command_receipts(id,film_id,operator_id,key,command,request_hash,response)
    VALUES(${randomUUID()},${filmId},${operatorId},${key},${command},${requestHash},${JSON.stringify(response)}::jsonb)`;
}

export async function readBudget(filmId:string,operatorId:string) {
  return pgClient.begin('isolation level read committed read only', async tx => projectionDto(await ownedAccount(tx,filmId,operatorId,false)));
}

export async function estimateAttempt(filmId:string,operatorId:string,input:EstimateAttempt) {
  return pgClient.begin('isolation level read committed read only', async tx => {
    await ownedAccount(tx,filmId,operatorId,false);
    const row=await loadRate(tx,input.rateCardSnapshotId);const calculated=estimate(rateValue(row),input.pricingUnits);
    return {rateCardSnapshotId:row.id,baseEstimateUsdMicros:calculated.baseEstimateUsdMicros.toString(),reservationUsdMicros:calculated.reservationUsdMicros.toString(),rateType:row.rate_type,expiresAt:new Date(row.expires_at).toISOString()};
  });
}

/** Atomically change a limit and its immutable audit event. */
export async function changeBudget(filmId:string,operatorId:string,key:string,input:UpdateBudget) {
  const requestHash=digest(input);
  return pgClient.begin('isolation level read committed',async tx=>{
    const account=await ownedAccount(tx,filmId,operatorId,true);
    const replay=await receipt<ReturnType<typeof projectionDto>>(tx,filmId,operatorId,key,'CHANGE_BUDGET',requestHash);
    if(replay)return replay;
    if(account.version!==input.expectedVersion)throw new ApiFailure(409,'VERSION_CONFLICT','Budget projection changed; reload before editing');
    const next=BigInt(input.budgetLimitUsdMicros);const committed=add(BigInt(account.actual_spent_usd_micros),BigInt(account.reserved_open_usd_micros));
    if(next<committed)throw new ApiFailure(409,'BUDGET_BELOW_COMMITTED','New limit cannot be below spent plus open reservations');
    const nextValue=next.toString();
    await tx`UPDATE film_budget_accounts SET budget_limit_usd_micros=${nextValue},version=version+1,updated_at=now() WHERE film_id=${filmId}`;
    await tx`UPDATE films SET budget_limit_usd_micros=${nextValue},updated_at=now() WHERE id=${filmId}`;
    await tx`INSERT INTO budget_limit_events(id,film_id,actor_id,prior_limit_usd_micros,new_limit_usd_micros,reason) VALUES(${randomUUID()},${filmId},${operatorId},${account.budget_limit_usd_micros},${nextValue},${input.reason})`;
    const updated={...account,budget_limit_usd_micros:next.toString(),version:account.version+1};const response=projectionDto(updated);
    await saveReceipt(tx,filmId,operatorId,key,'CHANGE_BUDGET',requestHash,response);return response;
  });
}

/** One transaction creates Attempt, reservation journal, projection, receipt and dispatch intent. */
export async function admitAttempt(filmId:string,operatorId:string,key:string,input:CreateAttempt):Promise<AttemptReceipt> {
  const requestHash=digest(input);
  return pgClient.begin('isolation level read committed',async tx=>{
    const account=await ownedAccount(tx,filmId,operatorId,true);
    const replay=await receipt<AttemptReceipt>(tx,filmId,operatorId,key,'ADMIT_ATTEMPT',requestHash);
    if(replay)return replay;
    const [story]=await tx<{id:string}[]>`SELECT sr.id FROM films f
      JOIN story_revisions sr ON sr.id=f.active_story_revision_id AND sr.film_id=f.id
      JOIN story_approvals sa ON sa.story_revision_id=sr.id
      JOIN story_validations sv ON sv.story_revision_id=sr.id
        AND sv.id::text=sa.evidence->>'validationRunId'
        AND sv.context='STORY_APPROVAL'
        AND sv.dependency_hash=sa.evidence->>'dependencyHash'
        AND sv.rule_set_version=sa.evidence->>'ruleSetVersion'
      WHERE f.id=${filmId} AND f.operator_id=${operatorId} AND sr.id=${input.storyRevisionId} AND sr.state='APPROVED'
        AND sa.evidence->>'storyRevisionId'=sr.id::text AND sa.evidence->>'contentHash'=sr.content_hash
        AND sa.evidence->>'ruleSetVersion'=${RULESET}
      FOR UPDATE OF f`;
    if(!story)throw new ApiFailure(409,'CURRENT_APPROVAL_REQUIRED','Attempt requires the active StoryRevision with current approval evidence');
    if(['IMAGE','VIDEO'].includes(input.kind) && !input.shotRevisionId)throw new ApiFailure(422,'SHOT_REVISION_REQUIRED','Image and video attempts require a ShotRevision');
    let shotId: string | null = null;
    if(input.shotRevisionId){
      const [shot]=await tx<{id:string;shot_id:string}[]>`SELECT sr.id, m.shot_id FROM shot_revisions sr JOIN story_revision_shots m ON m.film_id=sr.film_id AND m.shot_revision_id=sr.id WHERE sr.id=${input.shotRevisionId} AND sr.film_id=${filmId} AND m.story_revision_id=${input.storyRevisionId}`;
      if(!shot)throw new ApiFailure(422,'SHOT_REVISION_MISMATCH','ShotRevision is not part of the approved StoryRevision');
      shotId = shot.shot_id;
    }
    if (input.kind === 'VIDEO') {
      const [sr] = await tx<{ policy: { effectiveRequirement?: string; ruleTier?: string } | null }[]>`SELECT policy FROM shot_revisions WHERE id=${input.shotRevisionId} AND film_id=${filmId}`;
      const policyReq = (sr?.policy as { effectiveRequirement?: string } | null)?.effectiveRequirement;
      const isRequired = policyReq ? policyReq === 'REQUIRED' : true;
      if (isRequired) {
        const [approvedKeyframe] = await tx<{ asset_id: string; storage_path: string; sha256_hash: string }[]>`
          SELECT s.asset_id, a.storage_path, a.sha256_hash
          FROM shot_asset_selections s
          JOIN assets a ON a.id = s.asset_id
            AND a.film_id = s.film_id
            AND a.shot_revision_id = s.shot_revision_id
            AND a.kind = s.kind
          JOIN (
            SELECT DISTINCT ON (r.asset_id) r.asset_id, r.decision
            FROM asset_reviews r
            WHERE r.film_id = ${filmId}
            ORDER BY r.asset_id, r.created_at DESC, r.id DESC
          ) lr ON lr.asset_id = s.asset_id
          WHERE s.story_revision_id = ${input.storyRevisionId}
            AND s.shot_id = ${shotId}
            AND s.kind = 'IMAGE'
            AND s.shot_revision_id = ${input.shotRevisionId}
            AND a.film_id = ${filmId}
            AND a.shot_revision_id = ${input.shotRevisionId}
            AND a.kind = 'IMAGE'
            AND a.verified = true
            AND lr.decision = 'APPROVED'
          LIMIT 1
        `;
        if (!approvedKeyframe) {
          throw new ApiFailure(409, 'KEYFRAME_APPROVAL_REQUIRED', 'Video dispatch requires an approved, revision-compatible keyframe asset');
        }

        const category: AssetCategory = approvedKeyframe.storage_path.startsWith('keyframes') ? 'keyframes' : 'videos';
        const filename = path.basename(approvedKeyframe.storage_path);
        if (!storage.exists(category, filename)) {
          throw new ApiFailure(409, 'INTEGRITY_CHECK_FAILED', 'Approved keyframe asset missing from storage');
        }
        let verifiedOnDisk = false;
        try {
          verifiedOnDisk = await storage.verify(category, filename, approvedKeyframe.sha256_hash);
        } catch {
          verifiedOnDisk = false;
        }
        if (!verifiedOnDisk) {
          throw new ApiFailure(409, 'INTEGRITY_CHECK_FAILED', 'Approved keyframe asset failed disk integrity check');
        }
      }
    }
    const rate=await loadRate(tx,input.rateCardSnapshotId);
    if(rate.operation!==input.kind)throw new ApiFailure(422,'RATE_CARD_UNSUPPORTED','Rate card does not support this attempt kind');
    const calculated=estimate(rateValue(rate),input.pricingUnits);
    const executionMode = input.executionMode ?? 'REPLAY';
    const isReplay = executionMode === 'REPLAY';

    let reservationValue: string;
    if (isReplay) {
      reservationValue = '0';
    } else {
      assertAdmission(accountProjection(account),calculated.reservationUsdMicros);
      const committed=add(BigInt(account.actual_spent_usd_micros),BigInt(account.reserved_open_usd_micros),calculated.reservationUsdMicros);
      if(committed>BigInt(account.budget_limit_usd_micros))throw new ApiFailure(409,'BUDGET_EXCEEDED','Budget reservation would exceed the Film limit');
      reservationValue=calculated.reservationUsdMicros.toString();
    }
    const attemptId=randomUUID();
    await tx`INSERT INTO attempts(id,film_id,story_revision_id,shot_revision_id,kind,provider,model,rate_card_snapshot_id,pricing_units,reservation_usd_micros,execution_mode)
      VALUES(${attemptId},${filmId},${input.storyRevisionId},${input.shotRevisionId},${input.kind},${rate.provider},${rate.model},${rate.id},${input.pricingUnits},${reservationValue},${executionMode})`;

    if (isReplay) {
      await tx`INSERT INTO attempt_financial_state(attempt_id,reservation_open_usd_micros,billing_status) VALUES(${attemptId},'0','FINAL')`;
    } else {
      await tx`INSERT INTO attempt_financial_state(attempt_id,reservation_open_usd_micros) VALUES(${attemptId},${reservationValue})`;
      await tx`INSERT INTO cost_ledger_events(id,film_id,attempt_id,event_type,amount_usd_micros,billing_status,evidence,created_at)
      VALUES(${randomUUID()},${filmId},${attemptId},'RESERVATION_CREATED',${reservationValue},'PENDING',${JSON.stringify({rateCardSnapshotId:rate.id,pricingUnits:input.pricingUnits})}::jsonb,clock_timestamp())`;
      await tx`UPDATE film_budget_accounts SET reserved_open_usd_micros=reserved_open_usd_micros+${reservationValue},version=version+1,updated_at=now() WHERE film_id=${filmId}`;
    }

    const rawProvider = rate.provider.toUpperCase().replace(/[-.]/g, '_');
    let provider: ProviderKind;
    if (rawProvider === 'GOOGLE' || rawProvider === 'GEMINI') provider = 'GEMINI';
    else if (rawProvider === 'RUNWAY') provider = 'RUNWAY';
    else if (rawProvider === 'FAL_AI' || rawProvider === 'FAL_KLING') provider = 'FAL_KLING';
    else if (rawProvider === 'LOCAL_PAN_ZOOM') provider = 'LOCAL_PAN_ZOOM';
    else throw new ApiFailure(422, 'UNSUPPORTED_PROVIDER', `Unsupported rate card provider: ${rate.provider}`);

    let prompt = '';
    if (input.shotRevisionId) {
      const [sr] = await tx<{ spec: { prompt?: string } }[]>`SELECT spec FROM shot_revisions WHERE id = ${input.shotRevisionId} AND film_id = ${filmId}`;
      prompt = sr?.spec?.prompt ?? '';
    } else {
      const [film] = await tx<{ brief: string }[]>`SELECT brief FROM films WHERE id = ${filmId}`;
      prompt = film?.brief ?? '';
    }
    if (!prompt.trim()) {
      throw new ApiFailure(422, 'EMPTY_PROMPT', 'Attempt requires a non-empty prompt from ShotRevision or Film brief');
    }

    const defaultFixture = isReplay && !input.fixtureId
      ? resolveDefaultFixture({ provider, kind: input.kind, aspectRatio: '9:16' })
      : null;

    const snapshot = freezeGenerationRequestSnapshot({
      attemptId,
      filmId,
      shotRevisionId: input.shotRevisionId ?? null,
      kind: input.kind,
      provider,
      executionMode,
      prompt: prompt.trim(),
      aspectRatio: '9:16',
      fixturePackVersion: input.fixturePackVersion ?? defaultFixture?.packVersion,
      fixtureId: input.fixtureId ?? defaultFixture?.fixtureId,
    });

    const queueName = resolveOutboxQueue(input.kind, executionMode);
    await tx`INSERT INTO dispatch_outbox(id,attempt_id,queue_name,payload) VALUES(${randomUUID()},${attemptId},${queueName},${JSON.stringify(snapshot)}::jsonb)`;
    const billingStatus = isReplay ? 'FINAL' : 'PENDING';
    const response: AttemptReceipt = {
      attemptId,
      filmId,
      state: 'QUEUED',
      billingStatus,
      reservationUsdMicros: reservationValue,
      outboxStatus: 'PENDING',
    };
    await saveReceipt(tx,filmId,operatorId,key,'ADMIT_ATTEMPT',requestHash,response);return response;
  });
}

function financialDto(row:FinancialRow){return {attemptId:row.attempt_id,filmId:row.film_id,state:row.state,billingStatus:row.billing_status,
  reservationOpenUsdMicros:String(row.reservation_open_usd_micros),realizedUsdMicros:String(row.realized_usd_micros),pendingLiabilityUsdMicros:String(row.pending_liability_usd_micros),
  rateCardSnapshotId:row.rate_card_snapshot_id,outboxStatus:row.outbox_status,enqueueOutcome:row.enqueue_outcome,version:row.version};}

async function financialRow(tx:Tx,attemptId:string,operatorId:string,lock:boolean):Promise<FinancialRow>{
  const suffix=lock?' FOR UPDATE OF fs':'';
  const rows=await tx.unsafe<FinancialRow[]>(`SELECT a.id AS attempt_id,a.film_id,a.state,a.rate_card_snapshot_id,a.reservation_usd_micros,fs.billing_status,fs.reservation_open_usd_micros,fs.realized_usd_micros,fs.pending_liability_usd_micros,fs.version,o.status AS outbox_status,o.enqueue_outcome FROM attempts a JOIN films f ON f.id=a.film_id JOIN attempt_financial_state fs ON fs.attempt_id=a.id JOIN dispatch_outbox o ON o.attempt_id=a.id WHERE a.id=$1 AND f.operator_id=$2${suffix}`,[attemptId,operatorId]);
  if(!rows[0])throw new ApiFailure(404,'ATTEMPT_NOT_FOUND','Attempt not found');return rows[0];
}

export async function readAttemptFinancial(attemptId:string,operatorId:string){return pgClient.begin('isolation level read committed read only',async tx=>financialDto(await financialRow(tx,attemptId,operatorId,false)));}

/** Reconcile cumulative billing evidence; retries are durable command replays. */
export async function reconcileAttempt(attemptId:string,operatorId:string,key:string,input:ReconcileAttempt){
  const requestHash=digest(input);
  return pgClient.begin('isolation level read committed',async tx=>{
    const [attempt]=await tx<{film_id:string; execution_mode:string}[]>`SELECT a.film_id, a.execution_mode FROM attempts a JOIN films f ON f.id=a.film_id WHERE a.id=${attemptId} AND f.operator_id=${operatorId}`;
    if(!attempt)throw new ApiFailure(404,'ATTEMPT_NOT_FOUND','Attempt not found');
    if(attempt.execution_mode === 'REPLAY'){
      throw new ApiFailure(409, 'REPLAY_ATTEMPT_NON_RECONCILABLE', 'Replay attempts cannot be financially reconciled');
    }
    const account=await ownedAccount(tx,attempt.film_id,operatorId,true);const current=await financialRow(tx,attemptId,operatorId,true);
    const replay=await receipt<ReturnType<typeof financialDto>>(tx,current.film_id,operatorId,key,'RECONCILE_ATTEMPT',requestHash);if(replay)return replay;
    if(current.version!==input.expectedVersion)throw new ApiFailure(409,'VERSION_CONFLICT','Attempt financial state changed; reload before reconciling');
    const oldRealized=BigInt(current.realized_usd_micros),oldOpen=BigInt(current.reservation_open_usd_micros),oldPending=BigInt(current.pending_liability_usd_micros);
    const nextRealized=BigInt(input.realizedChargeUsdMicros),nextPending=BigInt(input.pendingLiabilityUsdMicros);
    if(input.billingStatus==='FINAL'&&nextPending!==0n)throw new ApiFailure(422,'FINAL_BILLING_HAS_PENDING','Final billing cannot retain a pending liability');
    const originalReservation=BigInt(current.reservation_usd_micros);
    const remaining=nextRealized>=originalReservation?0n:subtract(originalReservation,nextRealized);
    const nextOpen=input.billingStatus==='FINAL'?0n:(nextPending>remaining?nextPending:remaining);
    const spent=add(BigInt(account.actual_spent_usd_micros),nextRealized-oldRealized);
    const reserved=add(BigInt(account.reserved_open_usd_micros),nextOpen-oldOpen);
    const pending=add(BigInt(account.pending_liability_usd_micros),nextPending-oldPending);
    projection({budgetLimitUsdMicros:BigInt(account.budget_limit_usd_micros),actualSpentUsdMicros:spent,reservedOpenUsdMicros:reserved,pendingLiabilityUsdMicros:pending});
    if(nextRealized!==oldRealized){
      const [prior]=nextRealized<oldRealized?await tx<{id:string}[]>`SELECT id FROM cost_ledger_events WHERE attempt_id=${attemptId} AND event_type IN ('CHARGE_POSTED','CHARGE_CORRECTED') ORDER BY created_at DESC,id DESC LIMIT 1`:[];
      if(nextRealized<oldRealized&&!prior)throw new ApiFailure(409,'FINANCIAL_INTEGRITY','Correction requires a prior charge event');
      const evidence={evidenceRef:input.evidenceRef,...(prior?{correctionOfEventId:prior.id}:{})};
      await tx`INSERT INTO cost_ledger_events(id,film_id,attempt_id,event_type,amount_usd_micros,billing_status,evidence,created_at) VALUES(${randomUUID()},${current.film_id},${attemptId},${nextRealized>oldRealized?'CHARGE_POSTED':'CHARGE_CORRECTED'},${(nextRealized-oldRealized).toString()},${input.billingStatus},${JSON.stringify(evidence)}::jsonb,GREATEST(clock_timestamp(),COALESCE((SELECT max(created_at)+interval '1 microsecond' FROM cost_ledger_events WHERE attempt_id=${attemptId}),'-infinity'::timestamptz)))`;
    }
    if(nextOpen!==oldOpen)await tx`INSERT INTO cost_ledger_events(id,film_id,attempt_id,event_type,amount_usd_micros,billing_status,evidence,created_at) VALUES(${randomUUID()},${current.film_id},${attemptId},${nextOpen<oldOpen?'RESERVATION_RELEASED':'RESERVATION_ADJUSTED'},${(nextOpen<oldOpen?oldOpen-nextOpen:nextOpen-oldOpen).toString()},${input.billingStatus},${JSON.stringify({evidenceRef:input.evidenceRef})}::jsonb,GREATEST(clock_timestamp(),COALESCE((SELECT max(created_at)+interval '1 microsecond' FROM cost_ledger_events WHERE attempt_id=${attemptId}),'-infinity'::timestamptz)))`;
    await tx`UPDATE attempt_financial_state SET billing_status=${input.billingStatus},reservation_open_usd_micros=${nextOpen.toString()},realized_usd_micros=${nextRealized.toString()},pending_liability_usd_micros=${nextPending.toString()},version=version+1,updated_at=now() WHERE attempt_id=${attemptId}`;
    await tx`UPDATE film_budget_accounts SET actual_spent_usd_micros=${spent.toString()},reserved_open_usd_micros=${reserved.toString()},pending_liability_usd_micros=${pending.toString()},version=version+1,updated_at=now() WHERE film_id=${current.film_id}`;
    const response=financialDto({...current,billing_status:input.billingStatus,reservation_open_usd_micros:nextOpen.toString(),realized_usd_micros:nextRealized.toString(),pending_liability_usd_micros:nextPending.toString(),version:current.version+1});
    await saveReceipt(tx,current.film_id,operatorId,key,'RECONCILE_ATTEMPT',requestHash,response);return response;
  });
}

export async function readLedger(filmId:string,operatorId:string){return pgClient.begin('isolation level read committed read only',async tx=>{
  await ownedAccount(tx,filmId,operatorId,false);const rows=await tx<{id:string;attempt_id:string;event_type:string;amount_usd_micros:string;billing_status:string;evidence:unknown;created_at:Date|string}[]>`SELECT id,attempt_id,event_type,amount_usd_micros,billing_status,evidence,created_at FROM cost_ledger_events WHERE film_id=${filmId} ORDER BY created_at,id`;
  return rows.map(row=>({id:row.id,attemptId:row.attempt_id,eventType:row.event_type,amountUsdMicros:String(row.amount_usd_micros),billingStatus:row.billing_status,evidence:row.evidence,createdAt:new Date(row.created_at).toISOString()}));
});}

export async function readSummary(filmId:string,operatorId:string){return readBudget(filmId,operatorId);}

/** Compare immutable event/attempt sums with the locked Film projection without repairing drift. */
export async function auditFinancialProjection(filmId:string, onAfterAccountRead?: () => Promise<void> | void){
  return pgClient.begin('isolation level repeatable read read only', async tx => {
    const [account]=await tx<{actual_spent_usd_micros:string;reserved_open_usd_micros:string;pending_liability_usd_micros:string}[]>`SELECT actual_spent_usd_micros,reserved_open_usd_micros,pending_liability_usd_micros FROM film_budget_accounts WHERE film_id=${filmId}`;
    if(!account)throw new ApiFailure(404,'FILM_NOT_FOUND','Film not found');
    if(onAfterAccountRead)await onAfterAccountRead();
    const [events]=await tx<{actual:string;reserved:string}[]>`SELECT
      COALESCE(sum(CASE WHEN event_type IN ('CHARGE_POSTED','CHARGE_CORRECTED') THEN amount_usd_micros ELSE 0 END),0)::text AS actual,
      COALESCE(sum(CASE WHEN event_type='RESERVATION_CREATED' THEN amount_usd_micros WHEN event_type='RESERVATION_RELEASED' THEN -amount_usd_micros WHEN event_type='RESERVATION_ADJUSTED' THEN amount_usd_micros ELSE 0 END),0)::text AS reserved
      FROM cost_ledger_events WHERE film_id=${filmId}`;
    const [attempts]=await tx<{pending:string}[]>`SELECT COALESCE(sum(fs.pending_liability_usd_micros),0)::text AS pending FROM attempt_financial_state fs JOIN attempts a ON a.id=fs.attempt_id WHERE a.film_id=${filmId}`;
    const expected={actualSpentUsdMicros:events.actual,reservedOpenUsdMicros:events.reserved,pendingLiabilityUsdMicros:attempts.pending};
    const stored={actualSpentUsdMicros:String(account.actual_spent_usd_micros),reservedOpenUsdMicros:String(account.reserved_open_usd_micros),pendingLiabilityUsdMicros:String(account.pending_liability_usd_micros)};
    return {filmId,matches:expected.actualSpentUsdMicros===stored.actualSpentUsdMicros&&expected.reservedOpenUsdMicros===stored.reservedOpenUsdMicros&&expected.pendingLiabilityUsdMicros===stored.pendingLiabilityUsdMicros,expected,stored};
  });
}

export async function listRateCards(): Promise<{
  id: string;
  provider: string;
  model: string;
  operation: string;
  rateType: string;
  unitPriceUsdMicros: string;
}[]> {
  const rows = await pgClient<{
    id: string;
    provider: string;
    model: string;
    operation: string;
    rate_type: string;
    unit_price_usd_micros: string;
  }[]>`
    SELECT id, provider, model, operation, rate_type, unit_price_usd_micros
    FROM rate_card_snapshots
    WHERE expires_at > now()
    ORDER BY operation, provider
  `;
  return rows.map(r => ({
    id: r.id,
    provider: r.provider,
    model: r.model,
    operation: r.operation,
    rateType: r.rate_type,
    unitPriceUsdMicros: String(r.unit_price_usd_micros),
  }));
}


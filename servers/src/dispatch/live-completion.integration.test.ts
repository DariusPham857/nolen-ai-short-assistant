import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { canonicalStoryV2, type GenerationRequestV2 } from '@nolen/contracts';
import { unlock } from '../auth/sessions.js';
import { pgClient } from '../db/index.js';
import { migrateDatabase } from '../db/migrate.js';
import { auditFinancialProjection } from '../financial/repository.js';
import { createFinancialApi } from '../http/financial-api.js';
import { StorageAdapter } from '../lib/storage.js';
import type { PinnedTransportFn } from '../lib/remote-download.js';
import { LiveGeminiImageAdapter, LiveRunwayVideoAdapter } from '../providers/index.js';
import { completeLocalPanZoomAttempt } from './local-completion.js';
import { computeRequestFingerprint, recoverStaleSubmissions } from './service.js';
import { completeLiveAttempt } from './live-completion.js';

const isLiveDb = Boolean(process.env.DATABASE_URL);
const token = 'live-completion-test-token-at-least-32b';
const api = createFinancialApi();
let cookie = '';

async function request(
  route: string,
  method = 'GET',
  body?: unknown,
  key = randomUUID(),
): Promise<Response> {
  return api.request(`http://127.0.0.1:3000${route}`, {
    method,
    headers: {
      Origin: 'http://127.0.0.1:3000',
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe.runIf(isLiveDb)('Gate 2: LIVE Completion, Delta Settlement & v8.1 Receipt Guard (PostgreSQL 16)', () => {
  let tempRoot: string;
  let testStorage: StorageAdapter;

  beforeAll(async () => {
    process.env.OPERATOR_TOKEN = token;
    await migrateDatabase(process.env.DATABASE_URL!);
    cookie = `nolen_session=${await unlock(token)}`;
  });

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nolen-live-comp-'));
    testStorage = new StorageAdapter(tempRoot);
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    await pgClient.end();
  });

  async function seedFilmAndRates(budget = '1000000') {
    const filmId = randomUUID();
    const storyRevisionId = randomUUID();
    const sceneId = randomUUID();
    const shotId = randomUUID();
    const shotRevisionId = randomUUID();
    const validationRunId = randomUUID();
    const geminiRateId = randomUUID();
    const runwayRateId = randomUUID();

    await pgClient.begin(async tx => {
      await tx`INSERT INTO films(id, title, brief, budget_limit_usd_micros, operator_id, idempotency_key, request_hash)
        VALUES(${filmId}, 'LIVE Test Film', 'Cinematic rain', ${budget}, 'local-operator', ${randomUUID()}, 'fixture')`;
      await tx`INSERT INTO film_budget_accounts(film_id, operator_id, budget_limit_usd_micros)
        VALUES(${filmId}, 'local-operator', ${budget})`;
      await tx`INSERT INTO budget_limit_events(id, film_id, actor_id, prior_limit_usd_micros, new_limit_usd_micros, reason)
        VALUES(${randomUUID()}, ${filmId}, 'local-operator', ${budget}, ${budget}, 'baseline')`;

      const storyContent = canonicalStoryV2();
      const shotSpec = storyContent.scenes[0].shots[0].spec;
      await tx`INSERT INTO story_revisions(id, film_id, revision_no, state, content, content_hash)
        VALUES(${storyRevisionId}, ${filmId}, 1, 'APPROVED', ${JSON.stringify({ content: storyContent })}::jsonb, 'story-hash')`;
      await tx`UPDATE films SET active_story_revision_id=${storyRevisionId}, status='PLANNING' WHERE id=${filmId}`;

      await tx`INSERT INTO story_validations(id, story_revision_id, context, dependency_hash, rule_set_version, findings)
        VALUES(${validationRunId}, ${storyRevisionId}, 'STORY_APPROVAL', 'dep-hash', 'story-approval-2', '[]'::jsonb)`;
      await tx`INSERT INTO story_approvals(id, story_revision_id, evidence)
        VALUES(${randomUUID()}, ${storyRevisionId}, ${JSON.stringify({
          storyRevisionId,
          contentHash: 'story-hash',
          dependencyHash: 'dep-hash',
          ruleSetVersion: 'story-approval-2',
          validationRunId,
          waiverIds: [],
          waiverSetHash: 'waivers',
          actorId: 'local-operator',
          approvedAt: new Date().toISOString(),
          decision: 'APPROVED',
        })}::jsonb)`;

      await tx`INSERT INTO scenes(id, film_id) VALUES(${sceneId}, ${filmId})`;
      await tx`INSERT INTO story_revision_scenes(film_id, story_revision_id, scene_id, position)
        VALUES(${filmId}, ${storyRevisionId}, ${sceneId}, 1)`;
      await tx`INSERT INTO shots(id, film_id) VALUES(${shotId}, ${filmId})`;
      await tx`INSERT INTO shot_revisions(id, film_id, shot_id, spec, dependency_hash, policy)
        VALUES(${shotRevisionId}, ${filmId}, ${shotId}, ${JSON.stringify(shotSpec)}::jsonb, 'dep-1', ${JSON.stringify({ effectiveRequirement: 'REQUIRED' })}::jsonb)`;
      await tx`INSERT INTO story_revision_shots(film_id, story_revision_id, scene_id, shot_id, shot_revision_id, position)
        VALUES(${filmId}, ${storyRevisionId}, ${sceneId}, ${shotId}, ${shotRevisionId}, 1)`;

      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${geminiRateId}, 'GEMINI', 'gemini-3.1-flash-image', 'IMAGE', 'FIXED_PER_REQUEST', 67000, '2026-01-01', '2027-01-01', 'LIVE_VERIFIED test rate')`;
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${runwayRateId}, 'RUNWAY', 'gen4_turbo', 'VIDEO', 'PER_SECOND', 50000, '2026-01-01', '2027-01-01', 'LIVE_VERIFIED test rate')`;
    });

    return { filmId, storyRevisionId, sceneId, shotId, shotRevisionId, geminiRateId, runwayRateId };
  }

  async function seedLiveAttempt(
    s: Awaited<ReturnType<typeof seedFilmAndRates>>,
    opts: {
      kind: 'IMAGE' | 'VIDEO';
      provider: 'GEMINI' | 'RUNWAY' | 'LOCAL_PAN_ZOOM';
      reservationMicros: string;
      rateCardSnapshotId?: string;
      inputAssets?: GenerationRequestV2['inputAssets'];
    },
  ) {
    const attemptId = randomUUID();
    const rateId = opts.rateCardSnapshotId ?? (opts.kind === 'IMAGE' ? s.geminiRateId : s.runwayRateId);
    const modelId =
      opts.provider === 'GEMINI'
        ? 'gemini-3.1-flash-image'
        : opts.provider === 'LOCAL_PAN_ZOOM'
          ? 'ffmpeg-pan-zoom-v1'
          : 'gen4_turbo';
    const isLocal = opts.provider === 'LOCAL_PAN_ZOOM';

    const requestObj: GenerationRequestV2 = {
      schemaVersion: '2',
      attemptId,
      filmId: s.filmId,
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: opts.kind,
      provider: opts.provider,
      modelId,
      rateCardSnapshotId: rateId,
      executionMode: 'LIVE',
      prompt: 'Neon coffee shop in rain',
      negativePrompt: '',
      promptCompilerVersion: 'generation-intent-1',
      shotDependencyHash: 'dep-1',
      camera: { angle: 'EYE_LEVEL', framing: 'Medium', movement: 'Static' },
      aspectRatio: '9:16',
      ...(opts.kind === 'VIDEO' ? { durationSeconds: 5 } : {}),
      inputAssets: opts.inputAssets ?? [],
      structuredIntent: {
        shotType: 'CHARACTER',
        authoredPrompt: 'Neon coffee shop in rain',
        camera: { angle: 'EYE_LEVEL', framing: 'Medium', movement: 'Static' },
        location: { id: 'loc', name: 'Cafe', description: 'Rainy cafe' },
        styleRef: { id: 'style', name: 'Noir', description: 'Neon noir' },
        subjects: [],
        wardrobes: [],
        props: [],
        continuity: { startLighting: 'Neon', endLighting: 'Neon', startCharacters: [], endCharacters: [] },
        intendedTransitions: [],
      },
    };
    const fingerprint = computeRequestFingerprint(requestObj as unknown as Record<string, unknown>);

    await pgClient.begin(async tx => {
      await tx`SELECT * FROM film_budget_accounts WHERE film_id = ${s.filmId} FOR UPDATE`;
      await tx`INSERT INTO attempts(id, film_id, story_revision_id, shot_revision_id, kind, provider, model, rate_card_snapshot_id, pricing_units, reservation_usd_micros, execution_mode, state)
        VALUES(${attemptId}, ${s.filmId}, ${s.storyRevisionId}, ${s.shotRevisionId}, ${opts.kind}, ${opts.provider}, ${modelId}, ${rateId}, ${opts.kind === 'VIDEO' ? 5 : 1}, ${isLocal ? '0' : opts.reservationMicros}, 'LIVE', 'QUEUED')`;
      await tx`INSERT INTO attempt_financial_state(attempt_id, billing_status, reservation_open_usd_micros, realized_usd_micros, pending_liability_usd_micros)
        VALUES(${attemptId}, ${isLocal ? 'FINAL' : 'PENDING'}, ${isLocal ? '0' : opts.reservationMicros}, 0, 0)`;
      if (!isLocal) {
        await tx`INSERT INTO cost_ledger_events(id, film_id, attempt_id, event_type, amount_usd_micros, billing_status, evidence, created_at)
          VALUES(${randomUUID()}, ${s.filmId}, ${attemptId}, 'RESERVATION_CREATED', ${opts.reservationMicros}, 'PENDING', '{}'::jsonb, clock_timestamp())`;
        await tx`UPDATE film_budget_accounts SET reserved_open_usd_micros = reserved_open_usd_micros + ${opts.reservationMicros}::bigint, version = version + 1 WHERE film_id = ${s.filmId}`;
      }
      await tx`INSERT INTO dispatch_outbox(id, attempt_id, queue_name, payload)
        VALUES(${randomUUID()}, ${attemptId}, 'live:generation:dispatch', ${JSON.stringify({ request: requestObj, requestFingerprint: fingerprint })}::jsonb)`;
    });

    return attemptId;
  }

  function makePinnedVideoTransport(bytes: Buffer): PinnedTransportFn {
    return async () => ({
      statusCode: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.byteLength) },
      stream: (async function* () {
        yield bytes;
      })(),
      destroy: () => undefined,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // v8.1 Mandatory Case 1: Operator PENDING -> Worker PENDING
  // ───────────────────────────────────────────────────────────────────────────
  it('v8.1 Case 1: preserves operator-reconciled PENDING liability (10k on 100k res) when worker completes with PENDING', async () => {
    const s = await seedFilmAndRates();
    const attemptA = await seedLiveAttempt(s, { kind: 'IMAGE', provider: 'GEMINI', reservationMicros: '100000' });

    // Operator calls real reconcileAttempt API to set pending=10000, realized=0, status=PENDING
    const recRes = await request(`/api/attempts/${attemptA}/reconcile`, 'POST', {
      billingStatus: 'PENDING',
      realizedChargeUsdMicros: '0',
      pendingLiabilityUsdMicros: '10000',
      evidenceRef: 'operator:manual-hold-10k',
      expectedVersion: 0,
    });
    expect(recRes.status).toBe(200);

    const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const adapter = new LiveGeminiImageAdapter({
      apiKey: 'test-key',
      storage: testStorage,
      transportFn: async () => new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } }] } }],
        }),
        { status: 200 },
      ),
    });

    const res = await completeLiveAttempt(attemptA, { adapter, storage: testStorage });
    expect(res.outcome).toBe('SETTLED');
    expect(res).toMatchObject({ state: 'SUCCEEDED' });

    const [afs] = await pgClient<{
      billing_status: string;
      reservation_open_usd_micros: string;
      realized_usd_micros: string;
      pending_liability_usd_micros: string;
      version: number;
    }[]>`SELECT billing_status, reservation_open_usd_micros, realized_usd_micros, pending_liability_usd_micros, version FROM attempt_financial_state WHERE attempt_id = ${attemptA}`;
    expect(afs.billing_status).toBe('PENDING');
    expect(String(afs.pending_liability_usd_micros)).toBe('10000');
    expect(String(afs.reservation_open_usd_micros)).toBe('100000');
    expect(String(afs.realized_usd_micros)).toBe('0');
    expect(afs.version).toBe(1); // Only incremented once by reconcileAttempt, zero increment by worker

    const [fba] = await pgClient<{
      actual_spent_usd_micros: string;
      reserved_open_usd_micros: string;
      pending_liability_usd_micros: string;
    }[]>`SELECT actual_spent_usd_micros, reserved_open_usd_micros, pending_liability_usd_micros FROM film_budget_accounts WHERE film_id = ${s.filmId}`;
    expect(String(fba.pending_liability_usd_micros)).toBe('10000');
    expect(String(fba.reserved_open_usd_micros)).toBe('100000');
    expect(String(fba.actual_spent_usd_micros)).toBe('0');

    const ledgerRows = await pgClient<{ event_type: string }[]>`
      SELECT event_type FROM cost_ledger_events WHERE attempt_id = ${attemptA} ORDER BY created_at
    `;
    expect(ledgerRows.map(r => r.event_type)).toEqual(['RESERVATION_CREATED']);

    const reviews = await pgClient`SELECT * FROM asset_reviews WHERE film_id = ${s.filmId}`;
    expect(reviews.length).toBe(0); // PENDING_REVIEW (no auto-approve)

    const audit = await auditFinancialProjection(s.filmId);
    expect(audit.matches).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // v8.1 Mandatory Case 2: Receipt of another attempt on same film
  // ───────────────────────────────────────────────────────────────────────────
  it('v8.1 Case 2: receipt on Attempt A does not suppress pending initialization on unreconciled Attempt B of same film', async () => {
    const s = await seedFilmAndRates();
    const attemptA = await seedLiveAttempt(s, { kind: 'IMAGE', provider: 'GEMINI', reservationMicros: '100000' });
    const attemptB = await seedLiveAttempt(s, { kind: 'IMAGE', provider: 'GEMINI', reservationMicros: '40000' });

    const recRes = await request(`/api/attempts/${attemptA}/reconcile`, 'POST', {
      billingStatus: 'PENDING',
      realizedChargeUsdMicros: '0',
      pendingLiabilityUsdMicros: '10000',
      evidenceRef: 'operator:hold-a',
      expectedVersion: 0,
    });
    expect(recRes.status).toBe(200);

    const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const adapter = new LiveGeminiImageAdapter({
      apiKey: 'test-key',
      storage: testStorage,
      transportFn: async () => new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } }] } }],
        }),
        { status: 200 },
      ),
    });

    await completeLiveAttempt(attemptB, { adapter, storage: testStorage });

    const [afsA] = await pgClient<{ pending_liability_usd_micros: string }[]>`
      SELECT pending_liability_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptA}
    `;
    const [afsB] = await pgClient<{ pending_liability_usd_micros: string }[]>`
      SELECT pending_liability_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptB}
    `;
    const [fba] = await pgClient<{ pending_liability_usd_micros: string }[]>`
      SELECT pending_liability_usd_micros FROM film_budget_accounts WHERE film_id = ${s.filmId}
    `;

    expect(String(afsA.pending_liability_usd_micros)).toBe('10000');
    expect(String(afsB.pending_liability_usd_micros)).toBe('40000');
    expect(String(fba.pending_liability_usd_micros)).toBe('50000');
    expect((await auditFinancialProjection(s.filmId)).matches).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // v8.1 Mandatory Case 3: Overlapping operator & worker
  // ───────────────────────────────────────────────────────────────────────────
  it('v8.1 Case 3: overlapping operator reconcile committed before settlement lock is preserved by worker', async () => {
    const s = await seedFilmAndRates();
    const attemptA = await seedLiveAttempt(s, { kind: 'IMAGE', provider: 'GEMINI', reservationMicros: '100000' });

    const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const adapter = new LiveGeminiImageAdapter({
      apiKey: 'test-key',
      storage: testStorage,
      transportFn: async () => new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } }] } }],
        }),
        { status: 200 },
      ),
    });

    await completeLiveAttempt(attemptA, {
      adapter,
      storage: testStorage,
      onBeforeSettlementLock: async () => {
        // Worker already passed preflight & media; operator reconciles & commits right before worker acquires locks
        const recRes = await request(`/api/attempts/${attemptA}/reconcile`, 'POST', {
          billingStatus: 'PENDING',
          realizedChargeUsdMicros: '0',
          pendingLiabilityUsdMicros: '10000',
          evidenceRef: 'operator:overlap-hold',
          expectedVersion: 0,
        });
        expect(recRes.status).toBe(200);
      },
    });

    const [afs] = await pgClient<{ pending_liability_usd_micros: string; reservation_open_usd_micros: string }[]>`
      SELECT pending_liability_usd_micros, reservation_open_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptA}
    `;
    const [fba] = await pgClient<{ pending_liability_usd_micros: string }[]>`
      SELECT pending_liability_usd_micros FROM film_budget_accounts WHERE film_id = ${s.filmId}
    `;

    expect(String(afs.pending_liability_usd_micros)).toBe('10000');
    expect(String(afs.reservation_open_usd_micros)).toBe('100000');
    expect(String(fba.pending_liability_usd_micros)).toBe('10000');
    expect((await auditFinancialProjection(s.filmId)).matches).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // v8 BLOCK 1: PARTIAL 30k -> CONFIRMED_UNCHARGED
  // ───────────────────────────────────────────────────────────────────────────
  it('v8 BLOCK 1: PARTIAL 30k -> CONFIRMED_UNCHARGED emits negative CHARGE_CORRECTED (-30k) and settles at 0', async () => {
    const s = await seedFilmAndRates();
    const attemptId = await seedLiveAttempt(s, { kind: 'VIDEO', provider: 'RUNWAY', reservationMicros: '100000' });

    const partialRes = await request(`/api/attempts/${attemptId}/reconcile`, 'POST', {
      billingStatus: 'PARTIAL',
      realizedChargeUsdMicros: '30000',
      pendingLiabilityUsdMicros: '0',
      evidenceRef: 'runway:partial-30k',
      expectedVersion: 0,
    });
    expect(partialRes.status).toBe(200);

    const mp4Bytes = Buffer.from('video-bytes-ok');
    const adapter = new LiveRunwayVideoAdapter({
      apiKey: 'rw-key',
      storage: testStorage,
      transportFn: async url => {
        if (url.endsWith('/image_to_video')) return new Response(JSON.stringify({ id: 'rw-zero-1' }), { status: 200 });
        return new Response(
          JSON.stringify({
            id: 'rw-zero-1',
            status: 'SUCCEEDED',
            output: ['https://cdn.runwayml.com/rw-zero-1.mp4'],
            billing: { uncharged: true, evidenceRef: 'runway:voided-free-tier' },
          }),
          { status: 200 },
        );
      },
    });
    // Seed keyframe for v2 request
    await completeLiveAttempt(attemptId, {
      adapter: {
        kind: 'RUNWAY',
        executionMode: 'LIVE',
        isFake: false,
        submit: async req => ({
          attemptId: req.attemptId,
          providerJobId: 'rw-zero-1',
          state: 'SUBMITTED',
          executionMode: 'LIVE',
          provenance: 'LIVE_PROVIDER',
          submittedAt: new Date().toISOString(),
        }),
        pollStatus: async jobId => adapter.pollStatus(jobId),
        reconcile: async (id, jid) => adapter.reconcile(id, jid),
      },
      storage: testStorage,
      lookupFn: async () => [{ address: '34.120.0.1', family: 4 }],
      downloadTransportFn: makePinnedVideoTransport(mp4Bytes),
    });

    const ledger = await pgClient<{ event_type: string; amount_usd_micros: string }[]>`
      SELECT event_type, amount_usd_micros FROM cost_ledger_events WHERE attempt_id = ${attemptId} ORDER BY created_at
    `;
    expect(ledger.some(e => e.event_type === 'CHARGE_CORRECTED' && String(e.amount_usd_micros) === '-30000')).toBe(true);
    expect(ledger.some(e => e.event_type === 'RESERVATION_RELEASED' && String(e.amount_usd_micros) === '70000')).toBe(true);

    const [fba] = await pgClient<{ actual_spent_usd_micros: string; reserved_open_usd_micros: string }[]>`
      SELECT actual_spent_usd_micros, reserved_open_usd_micros FROM film_budget_accounts WHERE film_id = ${s.filmId}
    `;
    expect(String(fba.actual_spent_usd_micros)).toBe('0');
    expect(String(fba.reserved_open_usd_micros)).toBe('0');
    expect((await auditFinancialProjection(s.filmId)).matches).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // v8 BLOCK 2: Operator DISPUTED preserved when worker has PENDING
  // ───────────────────────────────────────────────────────────────────────────
  it('v8 BLOCK 2: preserves operator DISPUTED (20k realized, 10k pending, 80k open) when worker completes with PENDING', async () => {
    const s = await seedFilmAndRates();
    const attemptId = await seedLiveAttempt(s, { kind: 'IMAGE', provider: 'GEMINI', reservationMicros: '100000' });

    const dispRes = await request(`/api/attempts/${attemptId}/reconcile`, 'POST', {
      billingStatus: 'DISPUTED',
      realizedChargeUsdMicros: '20000',
      pendingLiabilityUsdMicros: '10000',
      evidenceRef: 'operator:disputed-20k',
      expectedVersion: 0,
    });
    expect(dispRes.status).toBe(200);

    const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const adapter = new LiveGeminiImageAdapter({
      apiKey: 'test-key',
      storage: testStorage,
      transportFn: async () => new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } }] } }],
        }),
        { status: 200 },
      ),
    });

    const settled = await completeLiveAttempt(attemptId, { adapter, storage: testStorage });
    expect(settled).toMatchObject({ state: 'SUCCEEDED', billingStatus: 'DISPUTED' });

    const [afs] = await pgClient<{
      billing_status: string;
      realized_usd_micros: string;
      pending_liability_usd_micros: string;
      reservation_open_usd_micros: string;
    }[]>`SELECT billing_status, realized_usd_micros, pending_liability_usd_micros, reservation_open_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptId}`;

    expect(afs.billing_status).toBe('DISPUTED');
    expect(String(afs.realized_usd_micros)).toBe('20000');
    expect(String(afs.pending_liability_usd_micros)).toBe('10000');
    expect(String(afs.reservation_open_usd_micros)).toBe('80000');
    expect((await auditFinancialProjection(s.filmId)).matches).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // v7 BLOCK 1 & BLOCK 4: Multi-attempt Film Pending & Reverse Media Race
  // ───────────────────────────────────────────────────────────────────────────
  it('preserves Attempt B pending liability on same film when Attempt A settles FINAL, and enforces terminal FAILED immutability on reverse race', async () => {
    const s = await seedFilmAndRates();
    const attemptA = await seedLiveAttempt(s, { kind: 'VIDEO', provider: 'RUNWAY', reservationMicros: '100000' });
    const attemptB = await seedLiveAttempt(s, { kind: 'IMAGE', provider: 'GEMINI', reservationMicros: '40000' });

    // Worker completes B with PENDING -> film pending = 40k
    const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const geminiAdapter = new LiveGeminiImageAdapter({
      apiKey: 'test-key',
      storage: testStorage,
      transportFn: async () => new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } }] } }],
        }),
        { status: 200 },
      ),
    });
    await completeLiveAttempt(attemptB, { adapter: geminiAdapter, storage: testStorage });

    // Reverse race on Attempt A:
    // Worker 1 encounters SSRF download block while billing is PENDING -> commits FAILED + PENDING (100k pending)
    await completeLiveAttempt(attemptA, {
      adapter: {
        kind: 'RUNWAY',
        executionMode: 'LIVE',
        isFake: false,
        submit: async req => ({
          attemptId: req.attemptId,
          providerJobId: 'rw-race-1',
          state: 'SUBMITTED',
          executionMode: 'LIVE',
          provenance: 'LIVE_PROVIDER',
          submittedAt: new Date().toISOString(),
        }),
        pollStatus: async jobId => ({
          providerJobId: jobId,
          state: 'SUCCEEDED',
          provenance: 'LIVE_PROVIDER',
          mediaUrl: 'http://169.254.169.254/latest/meta-data', // SSRF blocked!
          billingEvidence: { status: 'PENDING', evidenceRef: 'rw:pending' },
        }),
        reconcile: async (id, jid) => ({ attemptId: id, providerJobId: jid, outcome: 'UNRESOLVED_MANUAL_REVIEW', evidence: 'pending' }),
      },
      storage: testStorage,
    });

    // Clear outbox/attempt state precondition? Worker 2 passed preflight BEFORE Worker 1 committed, or resumes via poll with confirmed 70k charge + valid media.
    // Simulate Worker 2 settling A after A is already FAILED:
    // Wait: preflight fast-path blocks already terminal attempts unless Worker 2 passed preflight concurrently!
    // Use onBeforeSettlementLock on Worker 2 to prove concurrent race ordering: Worker 2 passes preflight, then Worker 1 commits FAILED+PENDING, then Worker 2 arrives at lock with media+70k!
    const attemptRace = await seedLiveAttempt(s, { kind: 'VIDEO', provider: 'RUNWAY', reservationMicros: '100000' });
    let worker1Done = false;
    await completeLiveAttempt(attemptRace, {
      adapter: {
        kind: 'RUNWAY',
        executionMode: 'LIVE',
        isFake: false,
        submit: async req => ({
          attemptId: req.attemptId,
          providerJobId: 'rw-race-2',
          state: 'SUBMITTED',
          executionMode: 'LIVE',
          provenance: 'LIVE_PROVIDER',
          submittedAt: new Date().toISOString(),
        }),
        pollStatus: async jobId => ({
          providerJobId: jobId,
          state: 'SUCCEEDED',
          provenance: 'LIVE_PROVIDER',
          mediaUrl: 'https://cdn.runwayml.com/race2.mp4',
          billingEvidence: { status: 'CONFIRMED_CHARGED', realizedChargeUsdMicros: '70000', evidenceRef: 'rw:inv:race2' },
        }),
        reconcile: async (id, jid) => ({ attemptId: id, providerJobId: jid, outcome: 'CONFIRMED_SUCCEEDED', evidence: 'ok' }),
      },
      storage: testStorage,
      lookupFn: async () => [{ address: '34.120.0.1', family: 4 }],
      downloadTransportFn: makePinnedVideoTransport(Buffer.from('valid-video')),
      onBeforeSettlementLock: async () => {
        // Simulate Worker 1 winning lock and committing FAILED + PENDING first
        await pgClient.begin(async tx => {
          await tx`UPDATE attempts SET state = 'FAILED' WHERE id = ${attemptRace}`;
          await tx`UPDATE outbound_dispatches SET state = 'FAILED' WHERE attempt_id = ${attemptRace}`;
          await tx`UPDATE attempt_financial_state SET pending_liability_usd_micros = 100000 WHERE attempt_id = ${attemptRace}`;
          await tx`UPDATE film_budget_accounts SET pending_liability_usd_micros = pending_liability_usd_micros + 100000 WHERE film_id = ${s.filmId}`;
        });
        worker1Done = true;
      },
    });
    expect(worker1Done).toBe(true);

    // Reverse race assertion: attemptRace MUST stay FAILED, 0 assets inserted, 70k charge settled, Attempt B's 40k pending preserved!
    const [attRaceRow] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${attemptRace}`;
    expect(attRaceRow.state).toBe('FAILED');
    const assetsRace = await pgClient`SELECT id FROM assets WHERE attempt_id = ${attemptRace}`;
    expect(assetsRace.length).toBe(0);

    const [fba] = await pgClient<{ pending_liability_usd_micros: string; actual_spent_usd_micros: string }[]>`
      SELECT pending_liability_usd_micros, actual_spent_usd_micros FROM film_budget_accounts WHERE film_id = ${s.filmId}
    `;
    // attemptA holds 100k pending, attemptB holds 40k pending, attemptRace released its 100k pending upon FINAL 70k settlement!
    expect(String(fba.pending_liability_usd_micros)).toBe('140000');
    expect(String(fba.actual_spent_usd_micros)).toBe('70000');
    expect((await auditFinancialProjection(s.filmId)).matches).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Crash Recovery (Milestone A & B) + Gemini LIVE -> Pan/Zoom Provenance
  // ───────────────────────────────────────────────────────────────────────────
  it('recovers Gemini inline keyframe across crash Milestone A, enforces producer sign-off before Pan/Zoom, and preserves LIVE_PROVIDER provenance (BLOCK 5)', async () => {
    const s = await seedFilmAndRates();
    const attemptId = await seedLiveAttempt(s, { kind: 'IMAGE', provider: 'GEMINI', reservationMicros: '67000' });

    const makeStaticPng320 = (): Buffer => {
      const width = 320;
      const height = 320;
      const stride = 1 + width * 3;
      const raw = Buffer.alloc(stride * height);
      for (let y = 0; y < height; y++) {
        raw[y * stride] = 0;
        for (let x = 0; x < width; x++) {
          const off = y * stride + 1 + x * 3;
          raw[off] = 40;
          raw[off + 1] = 120;
          raw[off + 2] = 200;
        }
      }
      const crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
      const crc32 = (buf: Buffer): number => {
        let crc = 0xffffffff;
        for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
      };
      const chunk = (type: string, data: Buffer): Buffer => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length, 0);
        const t = Buffer.from(type, 'ascii');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
        return Buffer.concat([len, t, data, crc]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(width, 0);
      ihdr.writeUInt32BE(height, 4);
      ihdr[8] = 8;
      ihdr[9] = 2;
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
      ]);
    };

    const pngBytes = makeStaticPng320();
    const pngSha = createHash('sha256').update(pngBytes).digest('hex');

    let submitCalls = 0;
    const crashingAdapter = new LiveGeminiImageAdapter({
      apiKey: 'gem-key',
      storage: testStorage,
      transportFn: async () => {
        submitCalls++;
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } }] } }],
          }),
          { status: 200 },
        );
      },
    });

    // Milestone A: Crash right after persisting gemini:${attemptId}:${sha256}
    await expect(
      completeLiveAttempt(attemptId, {
        adapter: crashingAdapter,
        storage: testStorage,
        simulateCrashAt: 'AFTER_SUBMIT_PERSIST',
      }),
    ).rejects.toThrow('SIMULATED_CRASH_AFTER_SUBMIT_PERSIST');
    expect(submitCalls).toBe(1);

    // Fresh worker + fresh adapter instance recovers from disk without calling submit() again
    const freshAdapter = new LiveGeminiImageAdapter({
      apiKey: 'gem-key',
      storage: testStorage,
      transportFn: async () => {
        submitCalls++;
        throw new Error('MUST NOT RESUBMIT');
      },
    });
    const recovered = await completeLiveAttempt(attemptId, { adapter: freshAdapter, storage: testStorage });
    expect(recovered).toMatchObject({ outcome: 'SETTLED', state: 'SUCCEEDED' });
    expect(submitCalls).toBe(1);

    const [asset] = await pgClient<{ id: string; metadata: Record<string, unknown> }[]>`
      SELECT id, metadata FROM assets WHERE attempt_id = ${attemptId}
    `;
    expect(asset.metadata).toMatchObject({ provenance: 'LIVE_PROVIDER', executionMode: 'LIVE', provider: 'GEMINI' });

    // Milestone B: Crash DURING_HTTP_BEFORE_PERSIST sweeps to SUBMISSION_UNCERTAIN without resubmitting
    const attemptUncertain = await seedLiveAttempt(s, { kind: 'IMAGE', provider: 'GEMINI', reservationMicros: '67000' });
    await expect(
      completeLiveAttempt(attemptUncertain, {
        adapter: crashingAdapter,
        storage: testStorage,
        simulateCrashAt: 'DURING_HTTP_BEFORE_PERSIST',
      }),
    ).rejects.toThrow('SIMULATED_CRASH_DURING_HTTP_BEFORE_PERSIST');
    const swept = await recoverStaleSubmissions(0);
    expect(swept.some(r => r.attemptId === attemptUncertain && r.recovered)).toBe(true);

    // Verify producer sign-off invariant + Pan/Zoom provenance inheritance
    await pgClient`
      INSERT INTO shot_asset_selections (story_revision_id, shot_id, kind, shot_revision_id, asset_id, film_id, selected_by)
      VALUES (${s.storyRevisionId}, ${s.shotId}, 'IMAGE', ${s.shotRevisionId}, ${asset.id}, ${s.filmId}, 'local-operator')
    `;
    await pgClient`
      INSERT INTO asset_reviews (id, asset_id, film_id, shot_revision_id, actor_id, decision, reason)
      VALUES (${randomUUID()}, ${asset.id}, ${s.filmId}, ${s.shotRevisionId}, 'local-operator', 'APPROVED', 'Keyframe approved')
    `;

    const pzAttemptId = await seedLiveAttempt(s, {
      kind: 'VIDEO',
      provider: 'LOCAL_PAN_ZOOM',
      reservationMicros: '0',
      inputAssets: [{ source: 'GENERATED_ASSET', role: 'START_FRAME', assetId: asset.id, sha256Hash: pngSha, mimeType: 'image/png' }],
    });

    const pzResult = await completeLocalPanZoomAttempt(pzAttemptId, {
      storage: testStorage,
    });
    expect(pzResult.state).toBe('SUCCEEDED');

    const [pzAsset] = await pgClient<{ metadata: { startFrameProvenance?: string } }[]>`
      SELECT metadata FROM assets WHERE attempt_id = ${pzAttemptId}
    `;
    expect(pzAsset.metadata.startFrameProvenance).toBe('LIVE_PROVIDER');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Forward Race, Reconcile Race & Parallel Racing Workers
  // ───────────────────────────────────────────────────────────────────────────
  it('handles forward race (SUCCEEDED+PENDING then failed download+70k charge), reconcile-before-media race, and simultaneous workers cleanly', async () => {
    const s = await seedFilmAndRates();

    // 1. Forward race (v6 BLOCK 2): Worker A succeeds media with PENDING, then Worker B has download failure + 70k CONFIRMED_CHARGED
    const attemptForward = await seedLiveAttempt(s, { kind: 'VIDEO', provider: 'RUNWAY', reservationMicros: '100000' });
    await completeLiveAttempt(attemptForward, {
      adapter: {
        kind: 'RUNWAY',
        executionMode: 'LIVE',
        isFake: false,
        submit: async req => ({
          attemptId: req.attemptId,
          providerJobId: 'rw-fwd-1',
          state: 'SUBMITTED',
          executionMode: 'LIVE',
          provenance: 'LIVE_PROVIDER',
          submittedAt: new Date().toISOString(),
        }),
        pollStatus: async jobId => ({
          providerJobId: jobId,
          state: 'SUCCEEDED',
          provenance: 'LIVE_PROVIDER',
          mediaUrl: 'http://169.254.169.254/ssrf-fail',
          billingEvidence: { status: 'CONFIRMED_CHARGED', realizedChargeUsdMicros: '70000', evidenceRef: 'rw:fwd:70k' },
        }),
        reconcile: async (id, jid) => ({ attemptId: id, providerJobId: jid, outcome: 'CONFIRMED_SUCCEEDED', evidence: 'ok' }),
      },
      storage: testStorage,
      onBeforeSettlementLock: async () => {
        // Worker A won lock earlier: inserted Asset, set SUCCEEDED, left AFS billing_status = 'PENDING'
        await pgClient.begin(async tx => {
          await tx`INSERT INTO assets(id, film_id, attempt_id, shot_revision_id, kind, storage_path, sha256_hash, mime_type, byte_size, verified, metadata)
            VALUES(${randomUUID()}, ${s.filmId}, ${attemptForward}, ${s.shotRevisionId}, 'VIDEO', 'videos/a.mp4', ${'a'.repeat(64)}, 'video/mp4', 100, true, '{"provenance":"LIVE_PROVIDER"}'::jsonb)`;
          await tx`UPDATE attempts SET state = 'SUCCEEDED' WHERE id = ${attemptForward}`;
          await tx`UPDATE outbound_dispatches SET state = 'SUCCEEDED' WHERE attempt_id = ${attemptForward}`;
        });
      },
    });
    const [attFwd] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${attemptForward}`;
    const [afsFwd] = await pgClient<{ billing_status: string; realized_usd_micros: string; reservation_open_usd_micros: string }[]>`
      SELECT billing_status, realized_usd_micros, reservation_open_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptForward}
    `;
    expect(attFwd.state).toBe('SUCCEEDED');
    expect(afsFwd.billing_status).toBe('FINAL');
    expect(String(afsFwd.realized_usd_micros)).toBe('70000');
    expect(String(afsFwd.reservation_open_usd_micros)).toBe('0');

    // 2. Reconcile-before-media race: Operator sets FINAL before worker finishes settlement -> worker STILL saves Asset and SUCCEEDED
    const attemptRecFirst = await seedLiveAttempt(s, { kind: 'IMAGE', provider: 'GEMINI', reservationMicros: '100000' });
    const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const geminiAdapter = new LiveGeminiImageAdapter({
      apiKey: 'gem-key',
      storage: testStorage,
      transportFn: async () => new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } }] } }],
        }),
        { status: 200 },
      ),
    });

    await completeLiveAttempt(attemptRecFirst, {
      adapter: geminiAdapter,
      storage: testStorage,
      onBeforeSettlementLock: async () => {
        const recRes = await request(`/api/attempts/${attemptRecFirst}/reconcile`, 'POST', {
          billingStatus: 'FINAL',
          realizedChargeUsdMicros: '50000',
          pendingLiabilityUsdMicros: '0',
          evidenceRef: 'operator:early-final',
          expectedVersion: 0,
        });
        expect(recRes.status).toBe(200);
      },
    });
    const [attRec] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${attemptRecFirst}`;
    const assetRec = await pgClient`SELECT id FROM assets WHERE attempt_id = ${attemptRecFirst}`;
    expect(attRec.state).toBe('SUCCEEDED');
    expect(assetRec.length).toBe(1);

    // 3. Simultaneous racing workers: exactly 1 CHARGE_POSTED and 1 Asset
    const attemptParallel = await seedLiveAttempt(s, { kind: 'VIDEO', provider: 'RUNWAY', reservationMicros: '100000' });
    const rwParallelAdapter = {
      kind: 'RUNWAY' as const,
      executionMode: 'LIVE' as const,
      isFake: false as const,
      submit: async (req: { attemptId: string }) => ({
        attemptId: req.attemptId,
        providerJobId: 'rw-par-1',
        state: 'SUBMITTED' as const,
        executionMode: 'LIVE' as const,
        provenance: 'LIVE_PROVIDER' as const,
        submittedAt: new Date().toISOString(),
      }),
      pollStatus: async (jobId: string) => ({
        providerJobId: jobId,
        state: 'SUCCEEDED' as const,
        provenance: 'LIVE_PROVIDER' as const,
        mediaUrl: 'https://cdn.runwayml.com/par.mp4',
        billingEvidence: { status: 'CONFIRMED_CHARGED' as const, realizedChargeUsdMicros: '70000', evidenceRef: 'rw:par:70k' },
      }),
      reconcile: async (id: string, jid: string | null) => ({ attemptId: id, providerJobId: jid, outcome: 'CONFIRMED_SUCCEEDED' as const, evidence: 'ok' }),
    };

    await Promise.all([
      completeLiveAttempt(attemptParallel, {
        adapter: rwParallelAdapter,
        storage: testStorage,
        lookupFn: async () => [{ address: '34.120.0.1', family: 4 }],
        downloadTransportFn: makePinnedVideoTransport(Buffer.from('par-video')),
      }),
      completeLiveAttempt(attemptParallel, {
        adapter: rwParallelAdapter,
        storage: testStorage,
        lookupFn: async () => [{ address: '34.120.0.1', family: 4 }],
        downloadTransportFn: makePinnedVideoTransport(Buffer.from('par-video')),
      }),
    ]);

    const charges = await pgClient`
      SELECT id FROM cost_ledger_events WHERE attempt_id = ${attemptParallel} AND event_type = 'CHARGE_POSTED'
    `;
    const parallelAssets = await pgClient`SELECT id FROM assets WHERE attempt_id = ${attemptParallel}`;
    expect(charges.length).toBe(1);
    expect(parallelAssets.length).toBe(1);
    expect((await auditFinancialProjection(s.filmId)).matches).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BLOCK 1 & BLOCK 2 Regression Tests (Runway 404 & Pre-Submit Cred Race)
  // ───────────────────────────────────────────────────────────────────────────
  it('BLOCK 1: Runway 404 preserves PENDING/PARTIAL charge and open reservation rather than reversing to 0', async () => {
    const s = await seedFilmAndRates();

    // (a) Fresh PENDING attempt (100k reservation) hits Runway 404 -> FAILED + PENDING hold preserved
    const attemptPending = await seedLiveAttempt(s, { kind: 'VIDEO', provider: 'RUNWAY', reservationMicros: '100000' });
    const rw404Adapter = new LiveRunwayVideoAdapter({
      apiKey: 'rw-key',
      storage: testStorage,
      transportFn: async url => {
        if (url.endsWith('/image_to_video')) return new Response(JSON.stringify({ id: 'rw-404-a' }), { status: 200 });
        return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
      },
    });
    const outPending = await completeLiveAttempt(attemptPending, {
      adapter: {
        kind: 'RUNWAY',
        executionMode: 'LIVE',
        isFake: false,
        submit: async req => ({
          attemptId: req.attemptId,
          providerJobId: 'rw-404-a',
          state: 'SUBMITTED',
          executionMode: 'LIVE',
          provenance: 'LIVE_PROVIDER',
          submittedAt: new Date().toISOString(),
        }),
        pollStatus: async id => rw404Adapter.pollStatus(id),
        reconcile: async (id, jid) => rw404Adapter.reconcile(id, jid),
      },
      storage: testStorage,
    });
    expect(outPending).toMatchObject({ outcome: 'SETTLED', state: 'FAILED', billingStatus: 'PENDING' });

    const [afsPending] = await pgClient<{
      billing_status: string;
      reservation_open_usd_micros: string;
      pending_liability_usd_micros: string;
    }[]>`SELECT billing_status, reservation_open_usd_micros, pending_liability_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptPending}`;
    expect(afsPending.billing_status).toBe('PENDING');
    expect(String(afsPending.reservation_open_usd_micros)).toBe('100000');
    expect(String(afsPending.pending_liability_usd_micros)).toBe('100000');

    // (b) Attempt with prior PARTIAL charge (30k realized, 70k open) hits Runway 404 -> preserves 30k realized & 70k open!
    const attemptPartial = await seedLiveAttempt(s, { kind: 'VIDEO', provider: 'RUNWAY', reservationMicros: '100000' });
    const partialRes = await request(`/api/attempts/${attemptPartial}/reconcile`, 'POST', {
      billingStatus: 'PARTIAL',
      realizedChargeUsdMicros: '30000',
      pendingLiabilityUsdMicros: '0',
      evidenceRef: 'runway:partial-before-404',
      expectedVersion: 0,
    });
    expect(partialRes.status).toBe(200);

    // Reconciliation already releases 30k of the original 100k reservation.
    // A later 404 must preserve this journal exactly, without new worker events.
    const ledgerBefore404 = await pgClient<{ id: string; event_type: string; amount_usd_micros: string }[]>`
      SELECT id, event_type, amount_usd_micros FROM cost_ledger_events
      WHERE attempt_id = ${attemptPartial} ORDER BY created_at, id
    `;

    const outPartial = await completeLiveAttempt(attemptPartial, {
      adapter: {
        kind: 'RUNWAY',
        executionMode: 'LIVE',
        isFake: false,
        submit: async req => ({
          attemptId: req.attemptId,
          providerJobId: 'rw-404-b',
          state: 'SUBMITTED',
          executionMode: 'LIVE',
          provenance: 'LIVE_PROVIDER',
          submittedAt: new Date().toISOString(),
        }),
        pollStatus: async id => rw404Adapter.pollStatus(id),
        reconcile: async (id, jid) => rw404Adapter.reconcile(id, jid),
      },
      storage: testStorage,
    });
    expect(outPartial).toMatchObject({ outcome: 'SETTLED', state: 'FAILED', billingStatus: 'PARTIAL' });

    const [afsPartial] = await pgClient<{
      billing_status: string;
      realized_usd_micros: string;
      reservation_open_usd_micros: string;
    }[]>`SELECT billing_status, realized_usd_micros, reservation_open_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptPartial}`;
    expect(afsPartial.billing_status).toBe('PARTIAL');
    expect(String(afsPartial.realized_usd_micros)).toBe('30000');
    expect(String(afsPartial.reservation_open_usd_micros)).toBe('70000');

    const ledgerPartial = await pgClient<{ id: string; event_type: string; amount_usd_micros: string }[]>`
      SELECT id, event_type, amount_usd_micros FROM cost_ledger_events
      WHERE attempt_id = ${attemptPartial} ORDER BY created_at, id
    `;
    expect(ledgerPartial).toEqual(ledgerBefore404);
    expect((await auditFinancialProjection(s.filmId)).matches).toBe(true);
  });

  it('BLOCK 2: missing-credential worker CAS fails cleanly when concurrent worker already claimed SUBMITTING/SUBMITTED, preserving financial hold', async () => {
    const s = await seedFilmAndRates();
    const attemptId = await seedLiveAttempt(s, { kind: 'IMAGE', provider: 'GEMINI', reservationMicros: '67000' });

    const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    let paidSubmitCalls = 0;
    const validAdapter = new LiveGeminiImageAdapter({
      apiKey: 'valid-gem-key',
      storage: testStorage,
      transportFn: async () => {
        paidSubmitCalls++;
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } }] } }],
          }),
          { status: 200 },
        );
      },
    });

    // Worker A lacks credentials, reads no existingDispatch, then pauses before pre-submit release tx
    // while Worker B (with key) claims SUBMITTING, submits paid call, and persists SUBMITTED (with PENDING billing)!
    await expect(
      completeLiveAttempt(attemptId, {
        storage: testStorage,
        adapterOptions: { apiKey: '' },
        onBeforePreSubmitRelease: async () => {
          const workerBOutcome = await completeLiveAttempt(attemptId, {
            adapter: validAdapter,
            storage: testStorage,
          });
          expect(workerBOutcome).toMatchObject({ outcome: 'SETTLED', state: 'SUCCEEDED', billingStatus: 'PENDING' });
        },
      }),
    ).rejects.toThrow('LIVE_PROVIDER_UNAVAILABLE');

    expect(paidSubmitCalls).toBe(1);

    const [dispatchRow] = await pgClient<{ state: string; provider_job_id: string | null }[]>`
      SELECT state, provider_job_id FROM outbound_dispatches WHERE attempt_id = ${attemptId}
    `;
    expect(dispatchRow.state).toBe('SUCCEEDED');
    expect(dispatchRow.provider_job_id).toContain(`gemini:${attemptId}:`);

    // Financial hold MUST remain intact (67,000 open & pending) and NOT released by Worker A!
    const [afs] = await pgClient<{
      billing_status: string;
      reservation_open_usd_micros: string;
      pending_liability_usd_micros: string;
    }[]>`SELECT billing_status, reservation_open_usd_micros, pending_liability_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptId}`;
    expect(afs.billing_status).toBe('PENDING');
    expect(String(afs.reservation_open_usd_micros)).toBe('67000');
    expect(String(afs.pending_liability_usd_micros)).toBe('67000');
    expect((await auditFinancialProjection(s.filmId)).matches).toBe(true);
  });
});

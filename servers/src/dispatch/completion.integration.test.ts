import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgClient } from '../db/index.js';
import { migrateDatabase } from '../db/migrate.js';
import { admitAttempt, resolveOutboxQueue } from '../financial/repository.js';
import { completeReplayAttempt, handleUnsupportedKindAttempt } from './completion.js';
import { storage } from '../lib/storage.js';
import { resolveFixture } from '../fixtures/resolver.js';

const isLiveDb = Boolean(process.env.DATABASE_URL);
const token = 'completion-test-operator-token-32b';

describe.runIf(isLiveDb)('Gate 2: Idempotent Completion Service & Concurrency/Crash Recovery (PostgreSQL 16)', () => {
  beforeAll(async () => {
    process.env.OPERATOR_TOKEN = token;
    await migrateDatabase(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await pgClient.end();
  });

  type FixtureOptions = {
    budget?: string;
    keyframePolicy?: 'REQUIRED' | 'OPTIONAL';
  };

  async function seedTestSetup(opts: FixtureOptions = {}) {
    const budget = opts.budget ?? '10000000'; // 10 USD
    const keyframePolicy = opts.keyframePolicy ?? 'OPTIONAL';

    const filmId = randomUUID();
    const storyRevisionId = randomUUID();
    const sceneId = randomUUID();
    const shotId = randomUUID();
    const shotRevisionId = randomUUID();
    const validationRunId = randomUUID();
    const geminiRateId = randomUUID();
    const runwayRateId = randomUUID();
    const falRateId = randomUUID();
    const ttsRateId = randomUUID();
    const assemblyRateId = randomUUID();

    await pgClient.begin(async tx => {
      // 1. Film & Budget
      await tx`INSERT INTO films(id, title, brief, budget_limit_usd_micros, operator_id, idempotency_key, request_hash)
        VALUES(${filmId}, 'Completion Test Film', 'A detective walking into the rain', ${budget}, 'local-operator', ${randomUUID()}, 'fixture')`;
      await tx`INSERT INTO film_budget_accounts(film_id, operator_id, budget_limit_usd_micros)
        VALUES(${filmId}, 'local-operator', ${budget})`;
      await tx`INSERT INTO budget_limit_events(id, film_id, actor_id, prior_limit_usd_micros, new_limit_usd_micros, reason)
        VALUES(${randomUUID()}, ${filmId}, 'local-operator', ${budget}, ${budget}, 'test baseline')`;

      // 2. Story Revision (Approved)
      await tx`INSERT INTO story_revisions(id, film_id, revision_no, state, content, content_hash)
        VALUES(${storyRevisionId}, ${filmId}, 1, 'APPROVED', '{"title":"Test Story"}'::jsonb, 'fixture-content-hash')`;
      await tx`UPDATE films SET active_story_revision_id=${storyRevisionId}, status='PLANNING' WHERE id=${filmId}`;

      await tx`INSERT INTO story_validations(id, story_revision_id, context, dependency_hash, rule_set_version, findings)
        VALUES(${validationRunId}, ${storyRevisionId}, 'STORY_APPROVAL', 'fixture-dependency', 'story-approval-2', '[]'::jsonb)`;
      await tx`INSERT INTO story_approvals(id, story_revision_id, evidence)
        VALUES(${randomUUID()}, ${storyRevisionId}, ${JSON.stringify({
          storyRevisionId,
          contentHash: 'fixture-content-hash',
          dependencyHash: 'fixture-dependency',
          ruleSetVersion: 'story-approval-2',
          validationRunId,
          waiverIds: [],
          waiverSetHash: 'fixture-waivers',
          actorId: 'local-operator',
          approvedAt: new Date().toISOString(),
          decision: 'APPROVED',
        })}::jsonb)`;

      // 3. Scene, Shot & ShotRevision
      await tx`INSERT INTO scenes(id, film_id) VALUES(${sceneId}, ${filmId})`;
      await tx`INSERT INTO story_revision_scenes(film_id, story_revision_id, scene_id, position)
        VALUES(${filmId}, ${storyRevisionId}, ${sceneId}, 1)`;

      await tx`INSERT INTO shots(id, film_id) VALUES(${shotId}, ${filmId})`;
      await tx`INSERT INTO shot_revisions(id, film_id, shot_id, spec, dependency_hash, policy)
        VALUES(${shotRevisionId}, ${filmId}, ${shotId}, '{"prompt":"Detective in trench coat under neon lights"}'::jsonb, 'dep-hash-1', ${JSON.stringify({ effectiveRequirement: keyframePolicy })}::jsonb)`;
      await tx`INSERT INTO story_revision_shots(film_id, story_revision_id, scene_id, shot_id, shot_revision_id, position)
        VALUES(${filmId}, ${storyRevisionId}, ${sceneId}, ${shotId}, ${shotRevisionId}, 1)`;

      // 4. Rate Cards
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${geminiRateId}, 'google', 'gemini-3.1-flash-image', 'IMAGE', 'FIXED_PER_REQUEST', 200000, '2026-01-01', '2027-01-01', 'gemini-rate-snapshot')`;
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${runwayRateId}, 'runway', 'gen4_turbo', 'VIDEO', 'PER_SECOND', 500000, '2026-01-01', '2027-01-01', 'runway-rate-snapshot')`;
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${falRateId}, 'fal_kling', 'fal-ai/kling-video/v3/pro/image-to-video', 'VIDEO', 'PER_SECOND', 500000, '2026-01-01', '2027-01-01', 'fal-rate-snapshot')`;
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${ttsRateId}, 'LOCAL_PAN_ZOOM', 'test-tts', 'TTS', 'FIXED_PER_REQUEST', 10000, '2026-01-01', '2027-01-01', 'tts-rate-snapshot')`;
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${assemblyRateId}, 'LOCAL_PAN_ZOOM', 'test-assembly', 'ASSEMBLY', 'FIXED_PER_REQUEST', 20000, '2026-01-01', '2027-01-01', 'assembly-rate-snapshot')`;
    });

    return {
      filmId,
      storyRevisionId,
      sceneId,
      shotId,
      shotRevisionId,
      geminiRateId,
      runwayRateId,
      falRateId,
      ttsRateId,
      assemblyRateId,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. PD-AT-01a: REPLAY Image Attempt Completion
  // ───────────────────────────────────────────────────────────────────────────
  it('PD-AT-01a: completes REPLAY image attempt with Gemini fixture, registers Asset and zero financial impact', async () => {
    const s = await seedTestSetup();

    // 1. Record budget before
    const [budgetBefore] = await pgClient<{
      budget_limit_usd_micros: string;
      actual_spent_usd_micros: string;
      reserved_open_usd_micros: string;
      pending_liability_usd_micros: string;
    }[]>`SELECT * FROM film_budget_accounts WHERE film_id = ${s.filmId}`;

    // 2. Admit REPLAY IMAGE attempt
    const admitted = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: s.geminiRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });

    expect(admitted.state).toBe('QUEUED');
    expect(admitted.billingStatus).toBe('FINAL');
    expect(admitted.reservationUsdMicros).toBe('0');

    // 3. Complete replay attempt
    const result = await completeReplayAttempt(admitted.attemptId);
    expect(result.state).toBe('SUCCEEDED');
    expect(result.alreadyCompleted).toBe(false);
    expect(result.assetId).toBeTruthy();
    const assetId = result.assetId!;

    // 4. Verify Asset row
    const [asset] = await pgClient<{
      id: string;
      film_id: string;
      attempt_id: string;
      shot_revision_id: string;
      kind: string;
      storage_path: string;
      sha256_hash: string;
      mime_type: string;
      byte_size: string;
      verified: boolean;
      metadata: Record<string, unknown>;
    }[]>`SELECT * FROM assets WHERE id = ${assetId}`;

    const expectedFixture = await resolveFixture('v1', 'default-gemini-image-9-16');
    expect(asset).toBeTruthy();
    expect(asset.attempt_id).toBe(admitted.attemptId);
    expect(asset.film_id).toBe(s.filmId);
    expect(asset.shot_revision_id).toBe(s.shotRevisionId);
    expect(asset.kind).toBe('IMAGE');
    expect(asset.sha256_hash).toBe(expectedFixture.sha256);
    expect(asset.mime_type).toBe('image/png');
    expect(BigInt(asset.byte_size)).toBe(BigInt(expectedFixture.byteSize));
    expect(asset.verified).toBe(true);
    expect(asset.metadata).toMatchObject({
      provenance: 'REPLAY_FIXTURE',
      executionMode: 'REPLAY',
      fixturePackVersion: 'v1',
      fixtureId: 'default-gemini-image-9-16',
      provider: 'GEMINI',
      aspectRatio: '9:16',
    });

    // 5. Verify file exists in content-addressed storage
    expect(storage.exists('keyframes', `${expectedFixture.sha256}.png`)).toBe(true);

    // 6. Verify attempt state in DB
    const [att] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${admitted.attemptId}`;
    expect(att.state).toBe('SUCCEEDED');

    // 7. Verify outbound_dispatches state in DB
    const [outbound] = await pgClient<{ state: string }[]>`SELECT state FROM outbound_dispatches WHERE attempt_id = ${admitted.attemptId}`;
    expect(outbound.state).toBe('SUCCEEDED');

    // 8. Verify dispatch_outbox state in DB
    const [outbox] = await pgClient<{ status: string; enqueue_outcome: string }[]>`
      SELECT status, enqueue_outcome FROM dispatch_outbox WHERE attempt_id = ${admitted.attemptId}
    `;
    expect(outbox.status).toBe('DELIVERED');
    expect(outbox.enqueue_outcome).toBe('WORKER_CONFIRMED');

    // 9. Financial integrity invariants: ZERO ledger events and unchanged budget account
    const [ledgerCount] = await pgClient<{ count: string }[]>`
      SELECT count(*)::text as count FROM cost_ledger_events WHERE attempt_id = ${admitted.attemptId}
    `;
    expect(ledgerCount.count).toBe('0');

    const [budgetAfter] = await pgClient<{
      budget_limit_usd_micros: string;
      actual_spent_usd_micros: string;
      reserved_open_usd_micros: string;
      pending_liability_usd_micros: string;
    }[]>`SELECT * FROM film_budget_accounts WHERE film_id = ${s.filmId}`;

    expect(budgetAfter).toEqual(budgetBefore);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. PD-AT-02a: REPLAY Video Attempt Completion
  // ───────────────────────────────────────────────────────────────────────────
  it('PD-AT-02a: completes REPLAY video attempt with Runway fixture, registers Asset and zero ledger events', async () => {
    const s = await seedTestSetup({ keyframePolicy: 'OPTIONAL' });

    // Admit REPLAY VIDEO attempt
    const admitted = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: s.runwayRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });

    const result = await completeReplayAttempt(admitted.attemptId);
    expect(result.state).toBe('SUCCEEDED');
    expect(result.assetId).toBeTruthy();
    const videoAssetId = result.assetId!;

    const expectedFixture = await resolveFixture('v1', 'default-runway-video-9-16');
    const [asset] = await pgClient<{
      id: string;
      kind: string;
      sha256_hash: string;
      mime_type: string;
      metadata: Record<string, unknown>;
    }[]>`SELECT id, kind, sha256_hash, mime_type, metadata FROM assets WHERE id = ${videoAssetId}`;

    expect(asset.kind).toBe('VIDEO');
    expect(asset.sha256_hash).toBe(expectedFixture.sha256);
    expect(asset.mime_type).toBe('video/mp4');
    expect(asset.metadata).toMatchObject({
      provenance: 'REPLAY_FIXTURE',
      fixtureId: 'default-runway-video-9-16',
      provider: 'RUNWAY',
    });

    expect(storage.exists('videos', `${expectedFixture.sha256}.mp4`)).toBe(true);

    const [ledgerCount] = await pgClient<{ count: string }[]>`
      SELECT count(*)::text as count FROM cost_ledger_events WHERE attempt_id = ${admitted.attemptId}
    `;
    expect(ledgerCount.count).toBe('0');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Mode-Prefixed Queue Routing (BLOCK 1)
  // ───────────────────────────────────────────────────────────────────────────
  it('BLOCK 1: resolves isolated queue names by mode and kind, protecting live queues', async () => {
    // Pure function assertions
    expect(resolveOutboxQueue('IMAGE', 'REPLAY')).toBe('replay:generation:dispatch');
    expect(resolveOutboxQueue('VIDEO', 'REPLAY')).toBe('replay:generation:dispatch');
    expect(resolveOutboxQueue('TTS', 'REPLAY')).toBe('replay:tts:dispatch');
    expect(resolveOutboxQueue('ASSEMBLY', 'REPLAY')).toBe('replay:assembly:dispatch');

    expect(resolveOutboxQueue('IMAGE', 'LIVE')).toBe('live:generation:dispatch');
    expect(resolveOutboxQueue('VIDEO', 'LIVE')).toBe('live:generation:dispatch');
    expect(resolveOutboxQueue('TTS', 'LIVE')).toBe('live:tts:dispatch');
    expect(resolveOutboxQueue('ASSEMBLY', 'LIVE')).toBe('live:assembly:dispatch');

    // DB Admission queue routing assertions
    const s = await seedTestSetup();

    // REPLAY TTS
    const replayTts = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: null,
      kind: 'TTS',
      rateCardSnapshotId: s.ttsRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });
    const [outboxReplayTts] = await pgClient<{ queue_name: string }[]>`
      SELECT queue_name FROM dispatch_outbox WHERE attempt_id = ${replayTts.attemptId}
    `;
    expect(outboxReplayTts.queue_name).toBe('replay:tts:dispatch');

    // REPLAY ASSEMBLY
    const replayAssembly = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: null,
      kind: 'ASSEMBLY',
      rateCardSnapshotId: s.assemblyRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });
    const [outboxReplayAssembly] = await pgClient<{ queue_name: string }[]>`
      SELECT queue_name FROM dispatch_outbox WHERE attempt_id = ${replayAssembly.attemptId}
    `;
    expect(outboxReplayAssembly.queue_name).toBe('replay:assembly:dispatch');

    // LIVE IMAGE
    const liveImage = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: s.geminiRateId,
      pricingUnits: 1,
      executionMode: 'LIVE',
    });
    const [outboxLiveImage] = await pgClient<{ queue_name: string }[]>`
      SELECT queue_name FROM dispatch_outbox WHERE attempt_id = ${liveImage.attemptId}
    `;
    expect(outboxLiveImage.queue_name).toBe('live:generation:dispatch');

    // LIVE TTS
    const liveTts = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: null,
      kind: 'TTS',
      rateCardSnapshotId: s.ttsRateId,
      pricingUnits: 1,
      executionMode: 'LIVE',
    });
    const [outboxLiveTts] = await pgClient<{ queue_name: string }[]>`
      SELECT queue_name FROM dispatch_outbox WHERE attempt_id = ${liveTts.attemptId}
    `;
    expect(outboxLiveTts.queue_name).toBe('live:tts:dispatch');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Deadlock-Free Misrouted Kind Handling (BLOCK 2)
  // ───────────────────────────────────────────────────────────────────────────
  it('BLOCK 2: handles misrouted TTS kind cleanly without deadlocking within bounded timeout', async () => {
    const s = await seedTestSetup();

    // Admit REPLAY TTS attempt
    const admitted = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: null,
      kind: 'TTS',
      rateCardSnapshotId: s.ttsRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });

    // Invoke completeReplayAttempt with bounded 2000ms timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT_DEADLOCK_DETECTED')), 2000)
    );

    const completionPromise = completeReplayAttempt(admitted.attemptId);
    const result = await Promise.race([completionPromise, timeoutPromise]);

    expect(result.state).toBe('FAILED');
    expect(result.alreadyCompleted).toBe(false);
    expect(result.error).toContain('UNSUPPORTED_REPLAY_KIND');

    // Verify DB states: attempt is FAILED, outbound is FAILED, outbox is WORKER_CONFIRMED
    const [att] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${admitted.attemptId}`;
    expect(att.state).toBe('FAILED');

    const [outbound] = await pgClient<{ state: string }[]>`SELECT state FROM outbound_dispatches WHERE attempt_id = ${admitted.attemptId}`;
    expect(outbound.state).toBe('FAILED');

    const [outbox] = await pgClient<{ status: string; enqueue_outcome: string }[]>`
      SELECT status, enqueue_outcome FROM dispatch_outbox WHERE attempt_id = ${admitted.attemptId}
    `;
    expect(outbox.status).toBe('DELIVERED');
    expect(outbox.enqueue_outcome).toBe('WORKER_CONFIRMED');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Terminal State CAS Protection (BLOCK 4)
  // ───────────────────────────────────────────────────────────────────────────
  it('BLOCK 4: preserves terminal states (CANCELED, FAILED, SUCCEEDED) for unsupported kinds via CAS', async () => {
    const s = await seedTestSetup();

    // 1. CANCELED attempt
    const c1 = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: null,
      kind: 'TTS',
      rateCardSnapshotId: s.ttsRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });
    await pgClient`UPDATE attempts SET state = 'CANCELED' WHERE id = ${c1.attemptId}`;

    const rCanceled = await handleUnsupportedKindAttempt(c1.attemptId, 'TTS');
    expect(rCanceled.state).toBe('CANCELED');
    expect(rCanceled.alreadyTerminal).toBe(true);
    expect(rCanceled.alreadyCompleted).toBe(true);

    const [attCanceled] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${c1.attemptId}`;
    expect(attCanceled.state).toBe('CANCELED'); // Not overwritten to FAILED!

    // 2. SUCCEEDED attempt
    const c2 = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: null,
      kind: 'TTS',
      rateCardSnapshotId: s.ttsRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });
    await pgClient`UPDATE attempts SET state = 'SUCCEEDED' WHERE id = ${c2.attemptId}`;

    const rSucceeded = await handleUnsupportedKindAttempt(c2.attemptId, 'TTS');
    expect(rSucceeded.state).toBe('SUCCEEDED');
    expect(rSucceeded.alreadyTerminal).toBe(true);

    const [attSucceeded] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${c2.attemptId}`;
    expect(attSucceeded.state).toBe('SUCCEEDED'); // Not overwritten to FAILED!

    // 3. FAILED attempt
    const c3 = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: null,
      kind: 'TTS',
      rateCardSnapshotId: s.ttsRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });
    await pgClient`UPDATE attempts SET state = 'FAILED' WHERE id = ${c3.attemptId}`;

    const rFailed = await handleUnsupportedKindAttempt(c3.attemptId, 'TTS');
    expect(rFailed.state).toBe('FAILED');
    expect(rFailed.alreadyTerminal).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Strict Provenance & Metadata Verification (BLOCK 3)
  // ───────────────────────────────────────────────────────────────────────────
  it('BLOCK 3: rejects already-completed attempts when Asset provenance or fixtureId does not match', async () => {
    const s = await seedTestSetup();

    // Seed attempt
    const admitted = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: s.geminiRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });

    const expectedFixture = await resolveFixture('v1', 'default-gemini-image-9-16');

    // Case A: Provenance mismatch (e.g. LIVE_PROVIDER)
    await pgClient`UPDATE attempts SET state = 'SUCCEEDED' WHERE id = ${admitted.attemptId}`;
    const storagePath = `keyframes/${expectedFixture.sha256}.png`;
    await pgClient`
      INSERT INTO assets (id, film_id, attempt_id, shot_revision_id, kind, storage_path, sha256_hash, mime_type, byte_size, verified, metadata, created_at)
      VALUES (${randomUUID()}, ${s.filmId}, ${admitted.attemptId}, ${s.shotRevisionId}, 'IMAGE',
        ${storagePath}, ${expectedFixture.sha256}, 'image/png', ${expectedFixture.byteSize}, true,
        ${JSON.stringify({ provenance: 'LIVE_PROVIDER' })}::jsonb, clock_timestamp())
    `;

    await expect(completeReplayAttempt(admitted.attemptId)).rejects.toThrow('ASSET_PROVENANCE_MISMATCH');

    // Case B: FixtureId mismatch
    await pgClient`
      UPDATE assets
      SET metadata = ${JSON.stringify({
        provenance: 'REPLAY_FIXTURE',
        fixtureId: 'wrong-fixture-id',
        fixturePackVersion: 'v1',
      })}::jsonb
      WHERE attempt_id = ${admitted.attemptId}
    `;

    await expect(completeReplayAttempt(admitted.attemptId)).rejects.toThrow('ASSET_FIXTURE_ID_MISMATCH');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Full Invariant Restoration on alreadyCompleted
  // ───────────────────────────────────────────────────────────────────────────
  it('recovers outbound_dispatches and outbox on retry when attempt is already SUCCEEDED', async () => {
    const s = await seedTestSetup();

    const admitted = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: s.geminiRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });

    // First completion succeeds
    const firstResult = await completeReplayAttempt(admitted.attemptId);
    expect(firstResult.alreadyCompleted).toBe(false);

    // Tamper with outbound_dispatches and dispatch_outbox to simulate partial crash after commit
    await pgClient`UPDATE outbound_dispatches SET state = 'SUBMITTED' WHERE attempt_id = ${admitted.attemptId}`;
    await pgClient`UPDATE dispatch_outbox SET status = 'PENDING', enqueue_outcome = 'NOT_ATTEMPTED' WHERE attempt_id = ${admitted.attemptId}`;

    // Second completion runs recovery
    const secondResult = await completeReplayAttempt(admitted.attemptId);
    expect(secondResult.alreadyCompleted).toBe(true);
    expect(secondResult.assetId).toBe(firstResult.assetId);

    // Assert outbound_dispatches and dispatch_outbox were restored to SUCCEEDED and WORKER_CONFIRMED
    const [outbound] = await pgClient<{ state: string }[]>`
      SELECT state FROM outbound_dispatches WHERE attempt_id = ${admitted.attemptId}
    `;
    expect(outbound.state).toBe('SUCCEEDED');

    const [outbox] = await pgClient<{ status: string; enqueue_outcome: string }[]>`
      SELECT status, enqueue_outcome FROM dispatch_outbox WHERE attempt_id = ${admitted.attemptId}
    `;
    expect(outbox.status).toBe('DELIVERED');
    expect(outbox.enqueue_outcome).toBe('WORKER_CONFIRMED');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Concurrency Race: ON CONFLICT (attempt_id) DO NOTHING
  // ───────────────────────────────────────────────────────────────────────────
  it('handles 2 concurrent completions idempotently, registering exactly 1 asset with identical ID', async () => {
    const s = await seedTestSetup();

    const admitted = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: s.geminiRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });

    // Run 2 completions concurrently
    const [res1, res2] = await Promise.all([
      completeReplayAttempt(admitted.attemptId),
      completeReplayAttempt(admitted.attemptId),
    ]);

    expect(res1.state).toBe('SUCCEEDED');
    expect(res2.state).toBe('SUCCEEDED');
    expect(res1.assetId).toBeTruthy();
    expect(res2.assetId).toBe(res1.assetId);

    // Exactly one asset row must exist
    const assetRows = await pgClient<{ id: string }[]>`
      SELECT id FROM assets WHERE attempt_id = ${admitted.attemptId}
    `;
    expect(assetRows).toHaveLength(1);
    expect(assetRows[0].id).toBe(res1.assetId);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 9. Crash Resiliency: AFTER_DISK_WRITE and AFTER_DB_COMMIT_BEFORE_ACK
  // ───────────────────────────────────────────────────────────────────────────
  it('recovers cleanly from simulated crash AFTER_DISK_WRITE', async () => {
    const s = await seedTestSetup();

    const admitted = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: s.geminiRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });

    // Simulate crash after file write
    await expect(
      completeReplayAttempt(admitted.attemptId, { simulateCrashAt: 'AFTER_DISK_WRITE' })
    ).rejects.toThrow('SIMULATED_CRASH_AFTER_DISK_WRITE');

    // Attempt in DB must still be QUEUED, no asset row exists
    const [att] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${admitted.attemptId}`;
    expect(att.state).toBe('QUEUED');

    const assetRows = await pgClient<{ id: string }[]>`SELECT id FROM assets WHERE attempt_id = ${admitted.attemptId}`;
    expect(assetRows).toHaveLength(0);

    // Normal retry completes successfully
    const retryResult = await completeReplayAttempt(admitted.attemptId);
    expect(retryResult.state).toBe('SUCCEEDED');
    expect(retryResult.assetId).toBeTruthy();

    const [attAfter] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${admitted.attemptId}`;
    expect(attAfter.state).toBe('SUCCEEDED');
  });

  it('recovers cleanly from simulated crash AFTER_DB_COMMIT_BEFORE_ACK', async () => {
    const s = await seedTestSetup();

    const admitted = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: s.geminiRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });

    // Simulate crash after DB commit
    await expect(
      completeReplayAttempt(admitted.attemptId, { simulateCrashAt: 'AFTER_DB_COMMIT_BEFORE_ACK' })
    ).rejects.toThrow('SIMULATED_CRASH_AFTER_DB_COMMIT_BEFORE_ACK');

    // Attempt in DB was committed as SUCCEEDED
    const [att] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${admitted.attemptId}`;
    expect(att.state).toBe('SUCCEEDED');

    // Normal retry enters alreadyCompleted branch, returns identical assetId
    const retryResult = await completeReplayAttempt(admitted.attemptId);
    expect(retryResult.state).toBe('SUCCEEDED');
    expect(retryResult.alreadyCompleted).toBe(true);
    expect(retryResult.assetId).toBeTruthy();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 10. Financial Invariant Gate: Rejects contaminated attempts
  // ───────────────────────────────────────────────────────────────────────────
  it('rejects attempt if financial state has open reservation or contaminated ledger events', async () => {
    const s = await seedTestSetup();

    const admitted = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: s.geminiRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });

    // Contaminate financial state
    await pgClient`
      UPDATE attempt_financial_state
      SET reservation_open_usd_micros = 500000, billing_status = 'PENDING'
      WHERE attempt_id = ${admitted.attemptId}
    `;

    await expect(completeReplayAttempt(admitted.attemptId)).rejects.toThrow('REPLAY_FINANCIAL_STATE_INVALID');
  });
});

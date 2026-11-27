import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalStoryV2 } from '@nolen/contracts';
import { pgClient } from '../db/index.js';
import { migrateDatabase } from '../db/migrate.js';
import { admitAttempt } from '../financial/repository.js';
import { previewAndAdmitMediaAttempt } from '../test-helpers/media-admission.js';
import { startWorker, type WorkerOptions } from './index.js';
import { WorkerLoopRunner } from './shutdown.js';
import { relayOne, type BossContract } from '../financial/outbox.js';
import { fakeAssetProducer } from '../assets/repository.js';
import { storage } from '../lib/storage.js';
import { seedBaselineRateCards } from '../db/seed-rate-cards.js';
import { computeRequestFingerprint, recoverStaleSubmittedDispatches } from '../dispatch/service.js';
import type { PollScheduler } from '../dispatch/live-completion.js';

function makeStaticPng320(): Buffer {
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
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const isLiveDb = Boolean(process.env.DATABASE_URL);
const token = 'worker-test-operator-token-32b';

describe.runIf(isLiveDb)('Gate 3: Worker Runtime Integration & Lifecycle (PostgreSQL 16)', () => {
  beforeAll(async () => {
    process.env.OPERATOR_TOKEN = token;
    await migrateDatabase(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await pgClient.end();
  });

  type FixtureOptions = {
    budget?: string;
  };

  async function seedWorkerSetup(opts: FixtureOptions = {}) {
    const budget = opts.budget ?? '10000000'; // 10 USD

    const filmId = randomUUID();
    const storyRevisionId = randomUUID();
    const sceneId = randomUUID();
    const shotId = randomUUID();
    const shotRevisionId = randomUUID();
    const validationRunId = randomUUID();
    const geminiRateId = randomUUID();
    const runwayRateId = randomUUID();
    const ttsRateId = randomUUID();
    const assemblyRateId = randomUUID();
    const keyframeAttemptId = randomUUID();

    await pgClient.begin(async tx => {
      // 1. Film & Budget
      await tx`INSERT INTO films(id, title, brief, budget_limit_usd_micros, operator_id, idempotency_key, request_hash)
        VALUES(${filmId}, 'Worker Test Film', 'Neon noir street', ${budget}, 'local-operator', ${randomUUID()}, 'fixture')`;
      await tx`INSERT INTO film_budget_accounts(film_id, operator_id, budget_limit_usd_micros)
        VALUES(${filmId}, 'local-operator', ${budget})`;
      await tx`INSERT INTO budget_limit_events(id, film_id, actor_id, prior_limit_usd_micros, new_limit_usd_micros, reason)
        VALUES(${randomUUID()}, ${filmId}, 'local-operator', ${budget}, ${budget}, 'test baseline')`;

      // 2. Story Revision (Approved) with valid StoryContent v2 + ShotSpec v2
      const storyContent = canonicalStoryV2();
      const shotSpec = storyContent.scenes[0].shots[0].spec;
      await tx`INSERT INTO story_revisions(id, film_id, revision_no, state, content, content_hash)
        VALUES(${storyRevisionId}, ${filmId}, 1, 'APPROVED', ${JSON.stringify({ content: storyContent })}::jsonb, 'fixture-hash')`;
      await tx`UPDATE films SET active_story_revision_id=${storyRevisionId}, status='PLANNING' WHERE id=${filmId}`;

      await tx`INSERT INTO story_validations(id, story_revision_id, context, dependency_hash, rule_set_version, findings)
        VALUES(${validationRunId}, ${storyRevisionId}, 'STORY_APPROVAL', 'fixture-dependency', 'story-approval-2', '[]'::jsonb)`;
      await tx`INSERT INTO story_approvals(id, story_revision_id, evidence)
        VALUES(${randomUUID()}, ${storyRevisionId}, ${JSON.stringify({
          storyRevisionId,
          contentHash: 'fixture-hash',
          dependencyHash: 'fixture-dependency',
          ruleSetVersion: 'story-approval-2',
          validationRunId,
          waiverIds: [],
          waiverSetHash: 'fixture-waivers',
          actorId: 'local-operator',
          approvedAt: new Date().toISOString(),
          decision: 'APPROVED',
        })}::jsonb)`;

      // 3. Scene, Shot & ShotRevision (keyframe policy OPTIONAL for direct video dispatch)
      await tx`INSERT INTO scenes(id, film_id) VALUES(${sceneId}, ${filmId})`;
      await tx`INSERT INTO story_revision_scenes(film_id, story_revision_id, scene_id, position)
        VALUES(${filmId}, ${storyRevisionId}, ${sceneId}, 1)`;

      await tx`INSERT INTO shots(id, film_id) VALUES(${shotId}, ${filmId})`;
      await tx`INSERT INTO shot_revisions(id, film_id, shot_id, spec, dependency_hash, policy)
        VALUES(${shotRevisionId}, ${filmId}, ${shotId}, ${JSON.stringify(shotSpec)}::jsonb, 'dep-hash-1', '{"effectiveRequirement":"OPTIONAL"}'::jsonb)`;
      await tx`INSERT INTO story_revision_shots(film_id, story_revision_id, scene_id, shot_id, shot_revision_id, position)
        VALUES(${filmId}, ${storyRevisionId}, ${sceneId}, ${shotId}, ${shotRevisionId}, 1)`;

      // 4. Rate Cards
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${geminiRateId}, 'google', 'gemini-3.1-flash-image', 'IMAGE', 'FIXED_PER_REQUEST', 200000, '2026-01-01', '2027-01-01', 'gemini-rate-snapshot')`;
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${runwayRateId}, 'runway', 'gen4_turbo', 'VIDEO', 'PER_SECOND', 500000, '2026-01-01', '2027-01-01', 'runway-rate-snapshot')`;
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${ttsRateId}, 'LOCAL_PAN_ZOOM', 'test-tts', 'TTS', 'FIXED_PER_REQUEST', 10000, '2026-01-01', '2027-01-01', 'LOCAL_VERIFIED tts-rate-snapshot')`;
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${assemblyRateId}, 'LOCAL_PAN_ZOOM', 'test-assembly', 'ASSEMBLY', 'FIXED_PER_REQUEST', 20000, '2026-01-01', '2027-01-01', 'LOCAL_VERIFIED assembly-rate-snapshot')`;

      // 5. Pre-seed keyframe attempt
      await tx`INSERT INTO attempts(id, film_id, story_revision_id, shot_revision_id, kind, provider, model, rate_card_snapshot_id, pricing_units, reservation_usd_micros, state, execution_mode)
        VALUES(${keyframeAttemptId}, ${filmId}, ${storyRevisionId}, ${shotRevisionId}, 'IMAGE', 'google', 'gemini-3.1-flash-image', ${geminiRateId}, 1, 0, 'SUCCEEDED', 'REPLAY')`;
    });

    // 6. Produce real keyframe asset on disk and approve it so image-driven video attempts succeed
    const keyframeAsset = await fakeAssetProducer({
      filmId,
      attemptId: keyframeAttemptId,
      shotRevisionId,
      kind: 'IMAGE',
    });
    await pgClient`INSERT INTO shot_asset_selections(film_id, story_revision_id, shot_id, shot_revision_id, kind, asset_id, selected_by)
      VALUES(${filmId}, ${storyRevisionId}, ${shotId}, ${shotRevisionId}, 'IMAGE', ${keyframeAsset.id}, 'local-operator')`;
    await pgClient`INSERT INTO asset_reviews(id, film_id, asset_id, shot_revision_id, decision, actor_id, reason)
      VALUES(${randomUUID()}, ${filmId}, ${keyframeAsset.id}, ${shotRevisionId}, 'APPROVED', 'local-operator', 'Approved keyframe fixture')`;

    return {
      filmId,
      storyRevisionId,
      sceneId,
      shotId,
      shotRevisionId,
      geminiRateId,
      runwayRateId,
      ttsRateId,
      assemblyRateId,
    };
  }

  async function pollAttemptState(attemptId: string, maxWaitMs = 15000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const [att] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${attemptId}`;
      if (att && ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(att.state)) {
        return att.state;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const [finalAtt] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${attemptId}`;
    return finalAtt?.state ?? 'UNKNOWN';
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Full 4-kind REPLAY E2E execution through real pg-boss
  // ───────────────────────────────────────────────────────────────────────────
  it('executes full 4-kind REPLAY E2E (IMAGE, VIDEO, TTS, ASSEMBLY) through real pg-boss', async () => {
    // Clean any prior pending outbox rows from other tests to avoid lease competition
    await pgClient`UPDATE dispatch_outbox SET status='DELIVERED', enqueue_outcome='WORKER_CONFIRMED', delivered_at=now() WHERE status = 'PENDING'`;

    const s = await seedWorkerSetup();
    const schema = `wb_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema });
    boss.on('error', () => undefined);

    const relayRunner = new WorkerLoopRunner({
      intervalMs: 100,
      passFn: async () => {
        try {
          await relayOne(boss as unknown as BossContract);
        } catch (error) {
          console.error('[worker] Outbox relay pass failed:', error);
        }
      },
    });

    const exitCalls: number[] = [];
    const worker = await startWorker({
      boss: boss as unknown as WorkerOptions['boss'],
      relayRunner,
      registerSignals: false,
      exitFn: code => exitCalls.push(code),
    });

    try {
      // 1. Admit 4 REPLAY attempts (media via preview+admit, TTS/ASSEMBLY via v1 direct admit)
      const { receipt: attImage } = await previewAndAdmitMediaAttempt(s.filmId, 'local-operator', randomUUID(), {
        storyRevisionId: s.storyRevisionId,
        shotRevisionId: s.shotRevisionId,
        kind: 'IMAGE',
        rateCardSnapshotId: s.geminiRateId,
        pricingUnits: 1,
        executionMode: 'REPLAY',
      });

      const { receipt: attVideo } = await previewAndAdmitMediaAttempt(s.filmId, 'local-operator', randomUUID(), {
        storyRevisionId: s.storyRevisionId,
        shotRevisionId: s.shotRevisionId,
        kind: 'VIDEO',
        rateCardSnapshotId: s.runwayRateId,
        pricingUnits: 5,
        executionMode: 'REPLAY',
      });

      const attTts = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
        storyRevisionId: s.storyRevisionId,
        shotRevisionId: null,
        kind: 'TTS',
        rateCardSnapshotId: s.ttsRateId,
        pricingUnits: 1,
        executionMode: 'REPLAY',
      });

      const attAssembly = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
        storyRevisionId: s.storyRevisionId,
        shotRevisionId: null,
        kind: 'ASSEMBLY',
        rateCardSnapshotId: s.assemblyRateId,
        pricingUnits: 1,
        executionMode: 'REPLAY',
      });

      // 2. Poll all attempts to terminal states
      const stateImage = await pollAttemptState(attImage.attemptId);
      const stateVideo = await pollAttemptState(attVideo.attemptId);
      const stateTts = await pollAttemptState(attTts.attemptId);
      const stateAssembly = await pollAttemptState(attAssembly.attemptId);

      // 3. Verify terminal outcomes
      expect(stateImage).toBe('SUCCEEDED');
      expect(stateVideo).toBe('SUCCEEDED');
      expect(stateTts).toBe('FAILED');
      expect(stateAssembly).toBe('FAILED');

      // 4. Verify Asset creation for media kinds
      const imageAssets = await pgClient<{ id: string; kind: string }[]>`SELECT id, kind FROM assets WHERE attempt_id = ${attImage.attemptId}`;
      expect(imageAssets).toHaveLength(1);
      expect(imageAssets[0].kind).toBe('IMAGE');

      const videoAssets = await pgClient<{ id: string; kind: string }[]>`SELECT id, kind FROM assets WHERE attempt_id = ${attVideo.attemptId}`;
      expect(videoAssets).toHaveLength(1);
      expect(videoAssets[0].kind).toBe('VIDEO');

      // 5. Verify outbox states are all WORKER_CONFIRMED
      const outboxRows = await pgClient<{ enqueue_outcome: string; status: string }[]>`
        SELECT enqueue_outcome, status FROM dispatch_outbox
        WHERE attempt_id IN (${attImage.attemptId}, ${attVideo.attemptId}, ${attTts.attemptId}, ${attAssembly.attemptId})
      `;
      expect(outboxRows).toHaveLength(4);
      expect(outboxRows.every(r => r.status === 'DELIVERED' && r.enqueue_outcome === 'WORKER_CONFIRMED')).toBe(true);

      // 6. Financial Invariants: ZERO ledger events for all 4 attempts
      const [ledgerCount] = await pgClient<{ count: string }[]>`
        SELECT count(*)::text as count FROM cost_ledger_events
        WHERE attempt_id IN (${attImage.attemptId}, ${attVideo.attemptId}, ${attTts.attemptId}, ${attAssembly.attemptId})
      `;
      expect(ledgerCount.count).toBe('0');
    } finally {
      await worker.shutdown();
      await pgClient.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. LIVE queue isolation: Replay worker never touches LIVE jobs
  // ───────────────────────────────────────────────────────────────────────────
  it('BLOCK 1: isolates LIVE queues so replay worker leaves LIVE attempts and reservations untouched', async () => {
    await pgClient`UPDATE dispatch_outbox SET status='DELIVERED', enqueue_outcome='WORKER_CONFIRMED', delivered_at=now() WHERE status = 'PENDING'`;

    const s = await seedWorkerSetup();
    const schema = `wb_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema });
    boss.on('error', () => undefined);

    // NOTICE: We do NOT call boss.createQueue here!
    // Production startWorker MUST create all ALL_PRODUCTION_QUEUES (both replay:* and live:*) on startup.

    const relayRunner = new WorkerLoopRunner({
      intervalMs: 100,
      passFn: async () => {
        try {
          await relayOne(boss as unknown as BossContract);
        } catch (error) {
          console.error('[worker] Outbox relay pass failed:', error);
        }
      },
    });

    const worker = await startWorker({
      boss: boss as unknown as WorkerOptions['boss'],
      relayRunner,
      registerSignals: false,
      exitFn: () => {},
      liveCompletionOptions: {
        adapterOptions: { apiKey: '' },
      },
    });

    try {
      // Unverified remote rate cards must be rejected at admission before dispatch (PD-05b.7)
      await expect(
        previewAndAdmitMediaAttempt(s.filmId, 'local-operator', randomUUID(), {
          storyRevisionId: s.storyRevisionId,
          shotRevisionId: s.shotRevisionId,
          kind: 'IMAGE',
          rateCardSnapshotId: s.geminiRateId,
          pricingUnits: 1,
          executionMode: 'LIVE',
        }),
      ).rejects.toMatchObject({ status: 422, code: 'UNVERIFIED_LIVE_RATE_CARD' });

      // 1. Admit 2 non-generation LIVE attempts: TTS (v1), ASSEMBLY (v1)
      const liveTts = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
        storyRevisionId: s.storyRevisionId,
        shotRevisionId: null,
        kind: 'TTS',
        rateCardSnapshotId: s.ttsRateId,
        pricingUnits: 1,
        executionMode: 'LIVE',
      });

      const liveAssembly = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
        storyRevisionId: s.storyRevisionId,
        shotRevisionId: null,
        kind: 'ASSEMBLY',
        rateCardSnapshotId: s.assemblyRateId,
        pricingUnits: 1,
        executionMode: 'LIVE',
      });

      const [outboxTts] = await pgClient<{ queue_name: string }[]>`SELECT queue_name FROM dispatch_outbox WHERE attempt_id = ${liveTts.attemptId}`;
      expect(outboxTts.queue_name).toBe('live:tts:dispatch');

      const [outboxAssembly] = await pgClient<{ queue_name: string }[]>`SELECT queue_name FROM dispatch_outbox WHERE attempt_id = ${liveAssembly.attemptId}`;
      expect(outboxAssembly.queue_name).toBe('live:assembly:dispatch');

      // Poll until relay delivers both LIVE TTS/ASSEMBLY attempts to pg-boss
      const startRelayWait = Date.now();
      let allDelivered = false;
      while (Date.now() - startRelayWait < 10000) {
        const outboxRows = await pgClient<{ status: string; enqueue_outcome: string }[]>`
          SELECT status, enqueue_outcome FROM dispatch_outbox
          WHERE attempt_id IN (${liveTts.attemptId}, ${liveAssembly.attemptId})
        `;
        if (outboxRows.length === 2 && outboxRows.every(r => r.status === 'DELIVERED')) {
          allDelivered = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(allDelivered).toBe(true);

      // Verify outbox rows: status is DELIVERED, outcome is JOB_ID
      const deliveredRows = await pgClient<{ status: string; enqueue_outcome: string; boss_job_id: string }[]>`
        SELECT status, enqueue_outcome, boss_job_id FROM dispatch_outbox
        WHERE attempt_id IN (${liveTts.attemptId}, ${liveAssembly.attemptId})
      `;
      expect(deliveredRows).toHaveLength(2);
      for (const row of deliveredRows) {
        expect(row.status).toBe('DELIVERED');
        expect(row.enqueue_outcome).toBe('JOB_ID');
        expect(row.boss_job_id).toBeTruthy();
      }

      // Verify live:tts and live:assembly attempts MUST stay QUEUED (no worker subscribed)
      const attRows = await pgClient<{ id: string; state: string; execution_mode: string }[]>`
        SELECT id, state, execution_mode FROM attempts
        WHERE id IN (${liveTts.attemptId}, ${liveAssembly.attemptId})
      `;
      expect(attRows).toHaveLength(2);
      for (const att of attRows) {
        expect(att.state).toBe('QUEUED');
        expect(att.execution_mode).toBe('LIVE');
      }

      // Financial reservations MUST remain open and intact
      const finRows = await pgClient<{ reservation_open_usd_micros: string; billing_status: string }[]>`
        SELECT reservation_open_usd_micros, billing_status FROM attempt_financial_state
        WHERE attempt_id IN (${liveTts.attemptId}, ${liveAssembly.attemptId})
      `;
      expect(finRows).toHaveLength(2);
      for (const fs of finRows) {
        expect(BigInt(fs.reservation_open_usd_micros) > 0n).toBe(true);
        expect(fs.billing_status).toBe('PENDING');
      }

      // Ledger events: exactly 1 per live attempt (RESERVATION_CREATED), zero charges/releases
      const [ledgerCount] = await pgClient<{ count: string }[]>`
        SELECT count(*)::text as count FROM cost_ledger_events
        WHERE attempt_id IN (${liveTts.attemptId}, ${liveAssembly.attemptId})
      `;
      expect(ledgerCount.count).toBe('2');
    } finally {
      await worker.shutdown();
      await pgClient.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it('LP-03: executes LIVE LOCAL_PAN_ZOOM VIDEO via live:generation:dispatch with real FFmpeg and fails closed on non-local LIVE payloads', async () => {
    await pgClient`UPDATE dispatch_outbox SET status='DELIVERED', enqueue_outcome='WORKER_CONFIRMED', delivered_at=now() WHERE status = 'PENDING'`;
    await seedBaselineRateCards(pgClient);
    const localVerifiedRateId = '00000000-0000-4000-a000-000000000005';

    const s = await seedWorkerSetup();
    // Upgrade START_FRAME asset on disk & DB to a valid 320x320 PNG so real FFmpeg decodes it cleanly
    const pngBytes = makeStaticPng320();
    const pngSha = createHash('sha256').update(pngBytes).digest('hex');
    await storage.write('keyframes', `${pngSha}.png`, pngBytes);
    await pgClient`
      UPDATE assets
      SET storage_path = ${`keyframes/${pngSha}.png`},
          sha256_hash = ${pngSha},
          byte_size = ${String(pngBytes.byteLength)},
          metadata = ${JSON.stringify({ provenance: 'REPLAY_FIXTURE', executionMode: 'REPLAY', provider: 'GEMINI' })}::jsonb
      WHERE film_id = ${s.filmId} AND kind = 'IMAGE'
    `;

    const schema = `wb_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema });
    boss.on('error', () => undefined);

    const relayRunner = new WorkerLoopRunner({
      intervalMs: 100,
      passFn: async () => {
        try {
          await relayOne(boss as unknown as BossContract);
        } catch (error) {
          console.error('[worker] Outbox relay pass failed:', error);
        }
      },
    });

    const worker = await startWorker({
      boss: boss as unknown as WorkerOptions['boss'],
      relayRunner,
      registerSignals: false,
      exitFn: () => {},
      liveCompletionOptions: {
        adapterOptions: { apiKey: '' },
      },
    });

    try {
      const { receipt } = await previewAndAdmitMediaAttempt(s.filmId, 'local-operator', randomUUID(), {
        storyRevisionId: s.storyRevisionId,
        shotRevisionId: s.shotRevisionId,
        kind: 'VIDEO',
        rateCardSnapshotId: localVerifiedRateId,
        pricingUnits: 5,
        executionMode: 'LIVE',
      });

      const terminal = await pollAttemptState(receipt.attemptId, 25000);
      expect(terminal).toBe('SUCCEEDED');

      const [videoAsset] = await pgClient<{ storage_path: string; metadata: Record<string, unknown> }[]>`
        SELECT storage_path, metadata FROM assets WHERE attempt_id = ${receipt.attemptId}
      `;
      expect(videoAsset.metadata).toMatchObject({
        provenance: 'LOCAL_PIPELINE',
        executionMode: 'LIVE',
        provider: 'LOCAL_PAN_ZOOM',
        startFrameProvenance: 'REPLAY_FIXTURE',
      });
      expect(storage.exists('videos', videoAsset.storage_path.replace('videos/', ''))).toBe(true);

      // Verify unconfigured remote LIVE payload on live:generation:dispatch fails closed without leaking reservation
      const badAttemptId = randomUUID();
      const badReq = {
        attemptId: badAttemptId,
        filmId: s.filmId,
        shotRevisionId: s.shotRevisionId,
        kind: 'IMAGE' as const,
        provider: 'GEMINI' as const,
        executionMode: 'LIVE' as const,
        prompt: 'Unconfigured live gemini key check',
        aspectRatio: '9:16' as const,
      };
      const badFp = computeRequestFingerprint(badReq);
      await pgClient.begin(async tx => {
        await tx`INSERT INTO attempts(id, film_id, story_revision_id, shot_revision_id, kind, provider, model, rate_card_snapshot_id, pricing_units, reservation_usd_micros, state, execution_mode)
          VALUES(${badAttemptId}, ${s.filmId}, ${s.storyRevisionId}, ${s.shotRevisionId}, 'IMAGE', 'GEMINI', 'gemini-3.1-flash-image', ${s.geminiRateId}, 1, '200000', 'QUEUED', 'LIVE')`;
        await tx`INSERT INTO attempt_financial_state(attempt_id, billing_status, reservation_open_usd_micros)
          VALUES(${badAttemptId}, 'PENDING', '200000')`;
        await tx`UPDATE film_budget_accounts SET reserved_open_usd_micros = reserved_open_usd_micros + 200000 WHERE film_id = ${s.filmId}`;
        await tx`INSERT INTO dispatch_outbox(id, attempt_id, queue_name, payload, status, enqueue_outcome)
          VALUES(${randomUUID()}, ${badAttemptId}, 'live:generation:dispatch', ${JSON.stringify({ request: badReq, requestFingerprint: badFp })}::jsonb, 'PENDING', 'NOT_ATTEMPTED')`;
      });

      const badTerminal = await pollAttemptState(badAttemptId, 10000);
      expect(badTerminal).toBe('FAILED');
      const [badOutbox] = await pgClient<{ status: string; enqueue_outcome: string }[]>`
        SELECT status, enqueue_outcome FROM dispatch_outbox WHERE attempt_id = ${badAttemptId}
      `;
      expect(badOutbox).toEqual({ status: 'DELIVERED', enqueue_outcome: 'WORKER_CONFIRMED' });
    } finally {
      await worker.shutdown();
      await pgClient.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it('fails closed when createQueue rejects on a LIVE queue during worker startup', async () => {
    const schema = `wb_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema });
    boss.on('error', () => undefined);

    const originalCreateQueue = boss.createQueue.bind(boss);
    vi.spyOn(boss, 'createQueue').mockImplementation(async (q: string) => {
      if (q === 'live:tts:dispatch') {
        throw new Error('Database permission error creating live:tts:dispatch');
      }
      return originalCreateQueue(q);
    });

    const relayRunner = new WorkerLoopRunner({ intervalMs: 100, passFn: async () => {} });
    const sweepRunner = new WorkerLoopRunner({ intervalMs: 100, passFn: async () => {} });
    const relayStartSpy = vi.spyOn(relayRunner, 'start');
    const sweepStartSpy = vi.spyOn(sweepRunner, 'start');

    await expect(
      startWorker({
        boss: boss as unknown as WorkerOptions['boss'],
        relayRunner,
        sweepRunner,
        registerSignals: false,
        exitFn: () => {},
      })
    ).rejects.toThrow('Database permission error creating live:tts:dispatch');

    expect(relayStartSpy).not.toHaveBeenCalled();
    expect(sweepStartSpy).not.toHaveBeenCalled();

    await boss.stop();
    await pgClient.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Cold-Start Recovery: Pre-existing outbox jobs relayed & processed upon boot
  // ───────────────────────────────────────────────────────────────────────────
  it('processes pre-existing outbox attempts cleanly on cold-start boot', async () => {
    await pgClient`UPDATE dispatch_outbox SET status='DELIVERED', enqueue_outcome='WORKER_CONFIRMED', delivered_at=now() WHERE status = 'PENDING'`;

    const s = await seedWorkerSetup();

    // Seed 2 REPLAY attempts while worker is offline
    const { receipt: att1 } = await previewAndAdmitMediaAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: s.geminiRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });

    const { receipt: att2 } = await previewAndAdmitMediaAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: s.runwayRateId,
      pricingUnits: 5,
      executionMode: 'REPLAY',
    });

    // Start worker after jobs were already admitted
    const schema = `wb_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema });
    boss.on('error', () => undefined);

    const relayRunner = new WorkerLoopRunner({
      intervalMs: 100,
      passFn: async () => {
        try {
          await relayOne(boss as unknown as BossContract);
        } catch (error) {
          console.error('[worker] Outbox relay pass failed:', error);
        }
      },
    });

    const worker = await startWorker({
      boss: boss as unknown as WorkerOptions['boss'],
      relayRunner,
      registerSignals: false,
      exitFn: () => {},
      liveCompletionOptions: {
        adapterOptions: { apiKey: '' },
      },
    });

    try {
      const state1 = await pollAttemptState(att1.attemptId);
      const state2 = await pollAttemptState(att2.attemptId);

      expect(state1).toBe('SUCCEEDED');
      expect(state2).toBe('SUCCEEDED');

      const assets = await pgClient<{ id: string }[]>`
        SELECT id FROM assets WHERE attempt_id IN (${att1.attemptId}, ${att2.attemptId})
      `;
      expect(assets).toHaveLength(2);
    } finally {
      await worker.shutdown();
      await pgClient.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. PD-05b Real pg-boss Multi-Turn Polling, SIGTERM Resumption & Sweeper Rescue
  // ───────────────────────────────────────────────────────────────────────────
  async function seedLiveRunwayOutboxAttempt(s: Awaited<ReturnType<typeof seedWorkerSetup>>, reservation = '100000') {
    const attemptId = randomUUID();
    const req = {
      attemptId,
      filmId: s.filmId,
      shotRevisionId: s.shotRevisionId,
      kind: 'VIDEO' as const,
      provider: 'RUNWAY' as const,
      executionMode: 'LIVE' as const,
      prompt: 'Slow cinematic dolly',
      aspectRatio: '9:16' as const,
      durationSeconds: 5,
    };
    const fp = computeRequestFingerprint(req);
    await pgClient.begin(async tx => {
      await tx`INSERT INTO attempts(id, film_id, story_revision_id, shot_revision_id, kind, provider, model, rate_card_snapshot_id, pricing_units, reservation_usd_micros, state, execution_mode)
        VALUES(${attemptId}, ${s.filmId}, ${s.storyRevisionId}, ${s.shotRevisionId}, 'VIDEO', 'RUNWAY', 'gen4_turbo', ${s.runwayRateId}, 5, ${reservation}, 'QUEUED', 'LIVE')`;
      await tx`INSERT INTO attempt_financial_state(attempt_id, billing_status, reservation_open_usd_micros)
        VALUES(${attemptId}, 'PENDING', ${reservation})`;
      await tx`INSERT INTO cost_ledger_events(id, film_id, attempt_id, event_type, amount_usd_micros, billing_status, evidence, created_at)
        VALUES(${randomUUID()}, ${s.filmId}, ${attemptId}, 'RESERVATION_CREATED', ${reservation}, 'PENDING', '{}'::jsonb, clock_timestamp())`;
      await tx`UPDATE film_budget_accounts SET reserved_open_usd_micros = reserved_open_usd_micros + ${reservation}::bigint WHERE film_id = ${s.filmId}`;
      await tx`INSERT INTO dispatch_outbox(id, attempt_id, queue_name, payload, status, enqueue_outcome)
        VALUES(${randomUUID()}, ${attemptId}, 'live:generation:dispatch', ${JSON.stringify({ request: req, requestFingerprint: fp })}::jsonb, 'PENDING', 'NOT_ATTEMPTED')`;
    });
    return attemptId;
  }

  it('v7 BLOCK 2: routes Turn 1 RUNNING -> Turn 2 live:generation:poll SUCCEEDED via real pg-boss with exactly 1 submit', async () => {
    await pgClient`UPDATE dispatch_outbox SET status='DELIVERED', enqueue_outcome='WORKER_CONFIRMED', delivered_at=now() WHERE status = 'PENDING'`;
    const s = await seedWorkerSetup();
    const attemptId = await seedLiveRunwayOutboxAttempt(s);

    let submitCount = 0;
    let pollCount = 0;
    const videoBytes = Buffer.from('runway-turn2-mp4');
    const adapter = {
      kind: 'RUNWAY' as const,
      executionMode: 'LIVE' as const,
      isFake: false as const,
      submit: async (req: { attemptId: string }) => {
        submitCount++;
        return {
          attemptId: req.attemptId,
          providerJobId: 'rw-multiturn-1',
          state: 'SUBMITTED' as const,
          executionMode: 'LIVE' as const,
          provenance: 'LIVE_PROVIDER' as const,
          submittedAt: new Date().toISOString(),
        };
      },
      pollStatus: async (jobId: string) => {
        pollCount++;
        if (pollCount <= 2) {
          return { providerJobId: jobId, state: 'RUNNING' as const, provenance: 'LIVE_PROVIDER' as const };
        }
        return {
          providerJobId: jobId,
          state: 'SUCCEEDED' as const,
          provenance: 'LIVE_PROVIDER' as const,
          mediaUrl: 'https://cdn.runwayml.com/multiturn.mp4',
          billingEvidence: { status: 'CONFIRMED_CHARGED' as const, realizedChargeUsdMicros: '80000', evidenceRef: 'rw:mt:1' },
        };
      },
      reconcile: async (id: string, jid: string | null) => ({ attemptId: id, providerJobId: jid, outcome: 'CONFIRMED_SUCCEEDED' as const, evidence: 'ok' }),
    };

    const schema = `wb_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema });
    boss.on('error', () => undefined);

    const worker = await startWorker({
      boss: boss as unknown as WorkerOptions['boss'],
      bossSchema: schema,
      relayRunner: new WorkerLoopRunner({
        intervalMs: 100,
        passFn: async () => {
          await relayOne(boss as unknown as BossContract).catch(() => undefined);
        },
      }),
      registerSignals: false,
      exitFn: () => {},
      liveCompletionOptions: {
        adapter,
        turnPollBudgetMs: 10, // Force Turn 1 expiration cleanly
        pollIntervalMs: 30,
        turnRescheduleDelaySec: 0,
        lookupFn: async () => [{ address: '34.120.0.1', family: 4 }],
        downloadTransportFn: async () => ({
          statusCode: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(videoBytes.byteLength) },
          stream: (async function* () { yield videoBytes; })(),
          destroy: () => undefined,
        }),
      },
    });

    try {
      const terminal = await pollAttemptState(attemptId, 15_000);
      expect(terminal).toBe('SUCCEEDED');
      expect(submitCount).toBe(1);
      expect(pollCount).toBeGreaterThanOrEqual(3);

      const pollJobs = await pgClient<{ id: string; state: string }[]>`
        SELECT id, state::text FROM ${pgClient.unsafe(`"${schema}".job`)}
        WHERE name = 'live:generation:poll' AND data->>'attemptId' = ${attemptId}
      `;
      expect(pollJobs.length).toBeGreaterThanOrEqual(1);
      expect(pollJobs[0].id).not.toBe(attemptId); // Distinct job.id on live:generation:poll
      expect(pollJobs.some(j => j.state === 'completed')).toBe(true);
    } finally {
      await worker.shutdown();
      await pgClient.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it('v7 BLOCK 3: SIGTERM shutdown during active RUNNING poll durably schedules live:generation:poll and Worker 2 completes with 1 submit', async () => {
    await pgClient`UPDATE dispatch_outbox SET status='DELIVERED', enqueue_outcome='WORKER_CONFIRMED', delivered_at=now() WHERE status = 'PENDING'`;
    const s = await seedWorkerSetup();
    const attemptId = await seedLiveRunwayOutboxAttempt(s);

    let submitCount = 0;
    let phase: 'WORKER_1' | 'WORKER_2' = 'WORKER_1';
    let firstPollHit!: () => void;
    const firstPollReady = new Promise<void>(r => { firstPollHit = r; });

    const videoBytes = Buffer.from('runway-sigterm-mp4');
    const adapter = {
      kind: 'RUNWAY' as const,
      executionMode: 'LIVE' as const,
      isFake: false as const,
      submit: async (req: { attemptId: string }) => {
        submitCount++;
        return {
          attemptId: req.attemptId,
          providerJobId: 'rw-sigterm-1',
          state: 'SUBMITTED' as const,
          executionMode: 'LIVE' as const,
          provenance: 'LIVE_PROVIDER' as const,
          submittedAt: new Date().toISOString(),
        };
      },
      pollStatus: async (jobId: string) => {
        if (phase === 'WORKER_1') {
          firstPollHit();
          return { providerJobId: jobId, state: 'RUNNING' as const, provenance: 'LIVE_PROVIDER' as const };
        }
        return {
          providerJobId: jobId,
          state: 'SUCCEEDED' as const,
          provenance: 'LIVE_PROVIDER' as const,
          mediaUrl: 'https://cdn.runwayml.com/sigterm.mp4',
          billingEvidence: { status: 'CONFIRMED_CHARGED' as const, realizedChargeUsdMicros: '80000', evidenceRef: 'rw:sigterm:1' },
        };
      },
      reconcile: async (id: string, jid: string | null) => ({ attemptId: id, providerJobId: jid, outcome: 'CONFIRMED_SUCCEEDED' as const, evidence: 'ok' }),
    };

    const schema = `wb_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const boss1 = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema });
    boss1.on('error', () => undefined);

    const worker1 = await startWorker({
      boss: boss1 as unknown as WorkerOptions['boss'],
      bossSchema: schema,
      relayRunner: new WorkerLoopRunner({
        intervalMs: 100,
        passFn: async () => { await relayOne(boss1 as unknown as BossContract).catch(() => undefined); },
      }),
      registerSignals: false,
      exitFn: () => {},
      liveCompletionOptions: {
        adapter,
        pollIntervalMs: 5_000, // Sleep interrupted by shutdown signal
        shutdownRescheduleDelaySec: 0,
      },
    });

    await firstPollReady;
    const shutdownRes = await worker1.shutdown();
    expect(shutdownRes.exitCode).toBe(0);

    // Boot Worker 2 on same schema
    phase = 'WORKER_2';
    const boss2 = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema });
    boss2.on('error', () => undefined);
    const worker2 = await startWorker({
      boss: boss2 as unknown as WorkerOptions['boss'],
      bossSchema: schema,
      relayRunner: new WorkerLoopRunner({ intervalMs: 100, passFn: async () => {} }),
      registerSignals: false,
      exitFn: () => {},
      liveCompletionOptions: {
        adapter,
        lookupFn: async () => [{ address: '34.120.0.1', family: 4 }],
        downloadTransportFn: async () => ({
          statusCode: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(videoBytes.byteLength) },
          stream: (async function* () { yield videoBytes; })(),
          destroy: () => undefined,
        }),
      },
    });

    try {
      const terminal = await pollAttemptState(attemptId, 15_000);
      expect(terminal).toBe('SUCCEEDED');
      expect(submitCount).toBe(1);
    } finally {
      await worker2.shutdown();
      await pgClient.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it('v8 BLOCK 3: continuation enqueue retry exhaustion fails job to failed, then recoverStaleSubmittedDispatches rescues video with 1 submit', async () => {
    await pgClient`UPDATE dispatch_outbox SET status='DELIVERED', enqueue_outcome='WORKER_CONFIRMED', delivered_at=now() WHERE status = 'PENDING'`;
    const s = await seedWorkerSetup();
    const attemptId = await seedLiveRunwayOutboxAttempt(s);

    let submitCount = 0;
    let allowPollSuccess = false;
    const videoBytes = Buffer.from('runway-rescued-mp4');
    const adapter = {
      kind: 'RUNWAY' as const,
      executionMode: 'LIVE' as const,
      isFake: false as const,
      submit: async (req: { attemptId: string }) => {
        submitCount++;
        return {
          attemptId: req.attemptId,
          providerJobId: 'rw-rescue-1',
          state: 'SUBMITTED' as const,
          executionMode: 'LIVE' as const,
          provenance: 'LIVE_PROVIDER' as const,
          submittedAt: new Date().toISOString(),
        };
      },
      pollStatus: async (jobId: string) => {
        if (!allowPollSuccess) {
          return { providerJobId: jobId, state: 'RUNNING' as const, provenance: 'LIVE_PROVIDER' as const };
        }
        return {
          providerJobId: jobId,
          state: 'SUCCEEDED' as const,
          provenance: 'LIVE_PROVIDER' as const,
          mediaUrl: 'https://cdn.runwayml.com/rescued.mp4',
          billingEvidence: { status: 'CONFIRMED_CHARGED' as const, realizedChargeUsdMicros: '80000', evidenceRef: 'rw:rescue:1' },
        };
      },
      reconcile: async (id: string, jid: string | null) => ({ attemptId: id, providerJobId: jid, outcome: 'CONFIRMED_SUCCEEDED' as const, evidence: 'ok' }),
    };

    const schema = `wb_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema });
    boss.on('error', () => undefined);
    await boss.start();

    // Provision live:generation:dispatch with retryLimit=2, retryDelay=0 so retry exhaustion reaches 'failed' quickly
    await boss.createQueue('live:generation:dispatch', { name: 'live:generation:dispatch', retryLimit: 2, retryDelay: 0 });

    let injectSendFailure = true;
    const originalSend = boss.send.bind(boss);
    vi.spyOn(boss, 'send').mockImplementation(async (name: string, data?: object, opts?: PgBoss.SendOptions) => {
      if (name === 'live:generation:poll' && injectSendFailure) {
        throw new Error('Simulated transient queue outage on continuation send');
      }
      return originalSend(name, data ?? {}, opts ?? {});
    });

    const worker = await startWorker({
      boss: boss as unknown as WorkerOptions['boss'],
      bossSchema: schema,
      relayRunner: new WorkerLoopRunner({
        intervalMs: 100,
        passFn: async () => { await relayOne(boss as unknown as BossContract).catch(() => undefined); },
      }),
      sweepRunner: new WorkerLoopRunner({ intervalMs: 60_000, passFn: async () => {} }),
      registerSignals: false,
      exitFn: () => {},
      liveCompletionOptions: {
        adapter,
        turnPollBudgetMs: 1,
        pollIntervalMs: 10,
        turnRescheduleDelaySec: 0,
        lookupFn: async () => [{ address: '34.120.0.1', family: 4 }],
        downloadTransportFn: async () => ({
          statusCode: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(videoBytes.byteLength) },
          stream: (async function* () { yield videoBytes; })(),
          destroy: () => undefined,
        }),
      },
    });

    try {
      // Wait for initial dispatch + 2 retries to exhaust -> job state = 'failed'
      const deadline = Date.now() + 10_000;
      let jobState = '';
      while (Date.now() < deadline) {
        const [j] = await pgClient<{ state: string }[]>`
          SELECT state::text FROM ${pgClient.unsafe(`"${schema}".job`)}
          WHERE name = 'live:generation:dispatch' AND id = ${attemptId}
        `;
        if (j?.state === 'failed') {
          jobState = j.state;
          break;
        }
        await new Promise(r => setTimeout(r, 100));
      }
      expect(jobState).toBe('failed');
      expect(submitCount).toBe(1); // Only 1 submit across all 3 tries because provider_job_id persisted on try 1!

      // Queue recovers and Runway finishes rendering
      injectSendFailure = false;
      allowPollSuccess = true;
      await new Promise(r => setTimeout(r, 50));

      const rescued = await recoverStaleSubmittedDispatches(boss as unknown as PollScheduler, schema, 10);
      expect(rescued.some(r => r.attemptId === attemptId && r.recovered)).toBe(true);

      const terminal = await pollAttemptState(attemptId, 15_000);
      expect(terminal).toBe('SUCCEEDED');
      expect(submitCount).toBe(1);
    } finally {
      await worker.shutdown();
      await pgClient.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });
});

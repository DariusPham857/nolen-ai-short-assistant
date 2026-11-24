import { randomUUID } from 'node:crypto';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgClient } from '../db/index.js';
import { migrateDatabase } from '../db/migrate.js';
import { admitAttempt } from '../financial/repository.js';
import { startWorker, type WorkerOptions } from './index.js';
import { WorkerLoopRunner } from './shutdown.js';
import { relayOne, type BossContract } from '../financial/outbox.js';

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

    await pgClient.begin(async tx => {
      // 1. Film & Budget
      await tx`INSERT INTO films(id, title, brief, budget_limit_usd_micros, operator_id, idempotency_key, request_hash)
        VALUES(${filmId}, 'Worker Test Film', 'Neon noir street', ${budget}, 'local-operator', ${randomUUID()}, 'fixture')`;
      await tx`INSERT INTO film_budget_accounts(film_id, operator_id, budget_limit_usd_micros)
        VALUES(${filmId}, 'local-operator', ${budget})`;
      await tx`INSERT INTO budget_limit_events(id, film_id, actor_id, prior_limit_usd_micros, new_limit_usd_micros, reason)
        VALUES(${randomUUID()}, ${filmId}, 'local-operator', ${budget}, ${budget}, 'test baseline')`;

      // 2. Story Revision (Approved)
      await tx`INSERT INTO story_revisions(id, film_id, revision_no, state, content, content_hash)
        VALUES(${storyRevisionId}, ${filmId}, 1, 'APPROVED', '{"title":"Worker Test"}'::jsonb, 'fixture-hash')`;
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
        VALUES(${shotRevisionId}, ${filmId}, ${shotId}, '{"prompt":"Detective in the shadows"}'::jsonb, 'dep-hash-1', '{"effectiveRequirement":"OPTIONAL"}'::jsonb)`;
      await tx`INSERT INTO story_revision_shots(film_id, story_revision_id, scene_id, shot_id, shot_revision_id, position)
        VALUES(${filmId}, ${storyRevisionId}, ${sceneId}, ${shotId}, ${shotRevisionId}, 1)`;

      // 4. Rate Cards
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${geminiRateId}, 'google', 'gemini-3.1-flash-image', 'IMAGE', 'FIXED_PER_REQUEST', 200000, '2026-01-01', '2027-01-01', 'gemini-rate-snapshot')`;
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${runwayRateId}, 'runway', 'gen4_turbo', 'VIDEO', 'PER_SECOND', 500000, '2026-01-01', '2027-01-01', 'runway-rate-snapshot')`;
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
      // 1. Admit 4 REPLAY attempts
      const attImage = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
        storyRevisionId: s.storyRevisionId,
        shotRevisionId: s.shotRevisionId,
        kind: 'IMAGE',
        rateCardSnapshotId: s.geminiRateId,
        pricingUnits: 1,
        executionMode: 'REPLAY',
      });

      const attVideo = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
        storyRevisionId: s.storyRevisionId,
        shotRevisionId: s.shotRevisionId,
        kind: 'VIDEO',
        rateCardSnapshotId: s.runwayRateId,
        pricingUnits: 1,
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
    });

    try {
      // 1. Admit 3 LIVE attempts: IMAGE, TTS, ASSEMBLY
      const liveImage = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
        storyRevisionId: s.storyRevisionId,
        shotRevisionId: s.shotRevisionId,
        kind: 'IMAGE',
        rateCardSnapshotId: s.geminiRateId,
        pricingUnits: 1,
        executionMode: 'LIVE',
      });

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

      expect(liveImage.reservationUsdMicros).toBe('200000');
      expect(liveImage.billingStatus).toBe('PENDING');

      // Verify outbox queue names are correctly routed to live:*
      const [outboxImage] = await pgClient<{ queue_name: string }[]>`SELECT queue_name FROM dispatch_outbox WHERE attempt_id = ${liveImage.attemptId}`;
      expect(outboxImage.queue_name).toBe('live:generation:dispatch');

      const [outboxTts] = await pgClient<{ queue_name: string }[]>`SELECT queue_name FROM dispatch_outbox WHERE attempt_id = ${liveTts.attemptId}`;
      expect(outboxTts.queue_name).toBe('live:tts:dispatch');

      const [outboxAssembly] = await pgClient<{ queue_name: string }[]>`SELECT queue_name FROM dispatch_outbox WHERE attempt_id = ${liveAssembly.attemptId}`;
      expect(outboxAssembly.queue_name).toBe('live:assembly:dispatch');

      // Poll until relay delivers all 3 attempts to pg-boss
      const startRelayWait = Date.now();
      let allDelivered = false;
      while (Date.now() - startRelayWait < 10000) {
        const outboxRows = await pgClient<{ status: string; enqueue_outcome: string }[]>`
          SELECT status, enqueue_outcome FROM dispatch_outbox
          WHERE attempt_id IN (${liveImage.attemptId}, ${liveTts.attemptId}, ${liveAssembly.attemptId})
        `;
        if (outboxRows.length === 3 && outboxRows.every(r => r.status === 'DELIVERED')) {
          allDelivered = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(allDelivered).toBe(true);

      // Verify outbox rows: NEVER EXHAUSTED! status is DELIVERED, outcome is JOB_ID
      const deliveredRows = await pgClient<{ status: string; enqueue_outcome: string; boss_job_id: string }[]>`
        SELECT status, enqueue_outcome, boss_job_id FROM dispatch_outbox
        WHERE attempt_id IN (${liveImage.attemptId}, ${liveTts.attemptId}, ${liveAssembly.attemptId})
      `;
      expect(deliveredRows).toHaveLength(3);
      for (const row of deliveredRows) {
        expect(row.status).toBe('DELIVERED');
        expect(row.enqueue_outcome).toBe('JOB_ID');
        expect(row.boss_job_id).toBeTruthy();
      }

      // Verify all 3 attempts MUST still be QUEUED (replay worker never consumes live:* queues!)
      const attRows = await pgClient<{ id: string; state: string; execution_mode: string }[]>`
        SELECT id, state, execution_mode FROM attempts
        WHERE id IN (${liveImage.attemptId}, ${liveTts.attemptId}, ${liveAssembly.attemptId})
      `;
      expect(attRows).toHaveLength(3);
      for (const att of attRows) {
        expect(att.state).toBe('QUEUED');
        expect(att.execution_mode).toBe('LIVE');
      }

      // Financial reservations MUST remain open and intact
      const finRows = await pgClient<{ reservation_open_usd_micros: string; billing_status: string }[]>`
        SELECT reservation_open_usd_micros, billing_status FROM attempt_financial_state
        WHERE attempt_id IN (${liveImage.attemptId}, ${liveTts.attemptId}, ${liveAssembly.attemptId})
      `;
      expect(finRows).toHaveLength(3);
      for (const fs of finRows) {
        expect(BigInt(fs.reservation_open_usd_micros) > 0n).toBe(true);
        expect(fs.billing_status).toBe('PENDING');
      }

      // Ledger events: exactly 1 per live attempt (RESERVATION_CREATED), zero charges/releases
      const [ledgerCount] = await pgClient<{ count: string }[]>`
        SELECT count(*)::text as count FROM cost_ledger_events
        WHERE attempt_id IN (${liveImage.attemptId}, ${liveTts.attemptId}, ${liveAssembly.attemptId})
      `;
      expect(ledgerCount.count).toBe('3');
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
    const att1 = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: s.geminiRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    });

    const att2 = await admitAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: s.runwayRateId,
      pricingUnits: 1,
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
});

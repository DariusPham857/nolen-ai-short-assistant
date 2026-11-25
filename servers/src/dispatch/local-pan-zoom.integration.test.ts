import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalStoryV2 } from '@nolen/contracts';
import { pgClient } from '../db/index.js';
import { migrateDatabase } from '../db/migrate.js';
import { seedBaselineRateCards } from '../db/seed-rate-cards.js';
import { storage } from '../lib/storage.js';
import { probeRenderedMp4 } from '../providers/ffmpeg-pan-zoom.js';
import { previewAndAdmitMediaAttempt } from '../test-helpers/media-admission.js';
import { completeLocalPanZoomAttempt } from './local-completion.js';

const isLiveDb = Boolean(process.env.DATABASE_URL);
const LOCAL_VERIFIED_RATE_ID = '00000000-0000-4000-a000-000000000005';
const REPLAY_GEMINI_RATE_ID = '00000000-0000-4000-a000-000000000001';

function generateUniquePngBuffer(hexColor: string): Buffer {
  return execFileSync(
    'ffmpeg',
    ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${hexColor}:s=720x1280:d=0.04`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
    { maxBuffer: 10 * 1024 * 1024 },
  );
}

describe.runIf(isLiveDb)('LP-001: LIVE LOCAL_PAN_ZOOM Completion & Invariants (PostgreSQL 16 + real FFmpeg)', () => {
  const createdKeyframes: string[] = [];

  beforeAll(async () => {
    await migrateDatabase(process.env.DATABASE_URL!);
    await seedBaselineRateCards(pgClient);
  });

  afterAll(async () => {
    for (const filename of createdKeyframes) {
      await storage.delete('keyframes', filename).catch(() => undefined);
    }
    await pgClient.end();
  });

  async function seedShotWithApprovedReplayKeyframe() {
    const filmId = randomUUID();
    const storyRevisionId = randomUUID();
    const sceneId = randomUUID();
    const shotId = randomUUID();
    const shotRevisionId = randomUUID();
    const validationRunId = randomUUID();
    const kfAttemptId = randomUUID();
    const kfAssetId = randomUUID();

    const pngBytes = generateUniquePngBuffer(randomUUID().replaceAll('-', '').slice(0, 6));
    const pngSha = createHash('sha256').update(pngBytes).digest('hex');
    await storage.write('keyframes', `${pngSha}.png`, pngBytes);
    createdKeyframes.push(`${pngSha}.png`);

    const storyContent = canonicalStoryV2();
    const shotSpec = storyContent.scenes[0].shots[0].spec;
    const durationSeconds = shotSpec.durationSeconds;

    await pgClient.begin(async tx => {
      await tx`INSERT INTO films(id, title, brief, budget_limit_usd_micros, operator_id, idempotency_key, request_hash)
        VALUES(${filmId}, 'LP Integration Film', 'Local pan/zoom film', '1000000', 'local-operator', ${randomUUID()}, 'fixture')`;
      await tx`INSERT INTO film_budget_accounts(film_id, operator_id, budget_limit_usd_micros)
        VALUES(${filmId}, 'local-operator', '1000000')`;
      await tx`INSERT INTO budget_limit_events(id, film_id, actor_id, prior_limit_usd_micros, new_limit_usd_micros, reason)
        VALUES(${randomUUID()}, ${filmId}, 'local-operator', '1000000', '1000000', 'baseline')`;

      await tx`INSERT INTO story_revisions(id, film_id, revision_no, state, content, content_hash)
        VALUES(${storyRevisionId}, ${filmId}, 1, 'APPROVED', ${JSON.stringify({ content: storyContent })}::jsonb, 'lp-content-hash')`;
      await tx`UPDATE films SET active_story_revision_id=${storyRevisionId}, status='PLANNING' WHERE id=${filmId}`;

      await tx`INSERT INTO story_validations(id, story_revision_id, context, dependency_hash, rule_set_version, findings)
        VALUES(${validationRunId}, ${storyRevisionId}, 'STORY_APPROVAL', 'lp-dep-hash', 'story-approval-2', '[]'::jsonb)`;
      await tx`INSERT INTO story_approvals(id, story_revision_id, evidence)
        VALUES(${randomUUID()}, ${storyRevisionId}, ${JSON.stringify({
          storyRevisionId,
          contentHash: 'lp-content-hash',
          dependencyHash: 'lp-dep-hash',
          ruleSetVersion: 'story-approval-2',
          validationRunId,
          waiverIds: [],
          waiverSetHash: 'lp-waivers',
          actorId: 'local-operator',
          approvedAt: new Date().toISOString(),
          decision: 'APPROVED',
        })}::jsonb)`;

      await tx`INSERT INTO scenes(id, film_id) VALUES(${sceneId}, ${filmId})`;
      await tx`INSERT INTO story_revision_scenes(film_id, story_revision_id, scene_id, position)
        VALUES(${filmId}, ${storyRevisionId}, ${sceneId}, 1)`;
      await tx`INSERT INTO shots(id, film_id) VALUES(${shotId}, ${filmId})`;
      await tx`INSERT INTO shot_revisions(id, film_id, shot_id, spec, dependency_hash, policy)
        VALUES(${shotRevisionId}, ${filmId}, ${shotId}, ${JSON.stringify(shotSpec)}::jsonb, 'shot-dep-1', '{"effectiveRequirement":"OPTIONAL"}'::jsonb)`;
      await tx`INSERT INTO story_revision_shots(film_id, story_revision_id, scene_id, shot_id, shot_revision_id, position)
        VALUES(${filmId}, ${storyRevisionId}, ${sceneId}, ${shotId}, ${shotRevisionId}, 1)`;

      // Approved REPLAY keyframe acting as START_FRAME
      await tx`INSERT INTO attempts(id, film_id, story_revision_id, shot_revision_id, kind, provider, model, rate_card_snapshot_id, pricing_units, reservation_usd_micros, state, execution_mode)
        VALUES(${kfAttemptId}, ${filmId}, ${storyRevisionId}, ${shotRevisionId}, 'IMAGE', 'GEMINI', 'gemini-3.1-flash-image', ${REPLAY_GEMINI_RATE_ID}, 1, '0', 'SUCCEEDED', 'REPLAY')`;
      await tx`INSERT INTO assets(id, film_id, attempt_id, shot_revision_id, kind, storage_path, sha256_hash, mime_type, byte_size, verified, metadata)
        VALUES(${kfAssetId}, ${filmId}, ${kfAttemptId}, ${shotRevisionId}, 'IMAGE', ${`keyframes/${pngSha}.png`}, ${pngSha}, 'image/png', ${String(pngBytes.byteLength)}, true, ${JSON.stringify({ provenance: 'REPLAY_FIXTURE', executionMode: 'REPLAY', provider: 'GEMINI' })}::jsonb)`;
      await tx`INSERT INTO shot_asset_selections(film_id, story_revision_id, shot_id, shot_revision_id, kind, asset_id, selected_by)
        VALUES(${filmId}, ${storyRevisionId}, ${shotId}, ${shotRevisionId}, 'IMAGE', ${kfAssetId}, 'local-operator')`;
      await tx`INSERT INTO asset_reviews(id, film_id, asset_id, shot_revision_id, decision, actor_id, reason)
        VALUES(${randomUUID()}, ${filmId}, ${kfAssetId}, ${shotRevisionId}, 'APPROVED', 'local-operator', 'Approved replay keyframe')`;
    });

    return { filmId, storyRevisionId, shotId, shotRevisionId, durationSeconds, kfAssetId, pngSha };
  }

  async function admitLiveLocalAttempt(s: Awaited<ReturnType<typeof seedShotWithApprovedReplayKeyframe>>) {
    const { receipt } = await previewAndAdmitMediaAttempt(s.filmId, 'local-operator', randomUUID(), {
      storyRevisionId: s.storyRevisionId,
      shotRevisionId: s.shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: LOCAL_VERIFIED_RATE_ID,
      pricingUnits: s.durationSeconds,
      executionMode: 'LIVE',
    });
    return receipt.attemptId;
  }

  it('LP-AT-01: renders real 1080x1920 h264 yuv420p MP4 with START_FRAME REPLAY_FIXTURE lineage and $0 settlement', async () => {
    const s = await seedShotWithApprovedReplayKeyframe();
    const attemptId = await admitLiveLocalAttempt(s);

    const [outboxBefore] = await pgClient<{ queue_name: string }[]>`
      SELECT queue_name FROM dispatch_outbox WHERE attempt_id = ${attemptId}
    `;
    expect(outboxBefore.queue_name).toBe('live:generation:dispatch');

    const res = await completeLocalPanZoomAttempt(attemptId, { storage: storage });
    expect(res.state).toBe('SUCCEEDED');
    expect(res.alreadyCompleted).toBe(false);
    expect(res.assetId).toBeTruthy();

    const [asset] = await pgClient<{
      id: string;
      kind: string;
      storage_path: string;
      sha256_hash: string;
      mime_type: string;
      metadata: Record<string, unknown>;
    }[]>`SELECT id, kind, storage_path, sha256_hash, mime_type, metadata FROM assets WHERE id = ${res.assetId!}`;

    expect(asset.kind).toBe('VIDEO');
    expect(asset.mime_type).toBe('video/mp4');
    expect(asset.storage_path).toBe(`videos/${asset.sha256_hash}.mp4`);
    expect(asset.metadata).toMatchObject({
      provenance: 'LOCAL_PIPELINE',
      executionMode: 'LIVE',
      provider: 'LOCAL_PAN_ZOOM',
      durationSeconds: s.durationSeconds,
      startFrameAssetId: s.kfAssetId,
      startFrameSha256: s.pngSha,
      startFrameProvenance: 'REPLAY_FIXTURE',
    });

    const probed = await probeRenderedMp4(
      storage.resolve('videos', path.basename(asset.storage_path)),
      s.durationSeconds,
    );
    expect(probed.width).toBe(1080);
    expect(probed.height).toBe(1920);
    expect(probed.nbFrames).toBe(s.durationSeconds * 30);

    const [fin] = await pgClient<{
      billing_status: string;
      reservation_open_usd_micros: string;
      realized_usd_micros: string;
      pending_liability_usd_micros: string;
    }[]>`SELECT billing_status, reservation_open_usd_micros, realized_usd_micros, pending_liability_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptId}`;
    expect(fin).toEqual({
      billing_status: 'FINAL',
      reservation_open_usd_micros: '0',
      realized_usd_micros: '0',
      pending_liability_usd_micros: '0',
    });

    const ledger = await pgClient<{ event_type: string; amount_usd_micros: string; billing_status: string; evidence: Record<string, unknown> }[]>`
      SELECT event_type, amount_usd_micros, billing_status, evidence FROM cost_ledger_events WHERE attempt_id = ${attemptId} ORDER BY created_at
    `;
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({ event_type: 'RESERVATION_CREATED', amount_usd_micros: '0', billing_status: 'PENDING' });
    expect(ledger[1]).toMatchObject({
      event_type: 'RESERVATION_RELEASED',
      amount_usd_micros: '0',
      billing_status: 'FINAL',
    });
    expect(ledger[1].evidence).toMatchObject({
      reason: 'LOCAL_PIPELINE_ZERO_API_FEE',
      startFrameProvenance: 'REPLAY_FIXTURE',
    });

    const [att] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${attemptId}`;
    expect(att.state).toBe('SUCCEEDED');
    const [outboxAfter] = await pgClient<{ status: string; enqueue_outcome: string }[]>`
      SELECT status, enqueue_outcome FROM dispatch_outbox WHERE attempt_id = ${attemptId}
    `;
    expect(outboxAfter).toEqual({ status: 'DELIVERED', enqueue_outcome: 'WORKER_CONFIRMED' });
  });

  it('LP-AT-02: recovers cleanly from AFTER_DISK_WRITE and AFTER_DB_COMMIT_BEFORE_ACK without duplicate assets or ledger rows', async () => {
    const s = await seedShotWithApprovedReplayKeyframe();
    const attemptBeforeCommit = await admitLiveLocalAttempt(s);

    await expect(
      completeLocalPanZoomAttempt(attemptBeforeCommit, {
        storage: storage,
        simulateCrashAt: 'AFTER_DISK_WRITE',
      }),
    ).rejects.toThrow('SIMULATED_CRASH_AFTER_DISK_WRITE');

    const [attPre] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${attemptBeforeCommit}`;
    expect(attPre.state).toBe('QUEUED');
    const [assetsPre] = await pgClient<{ count: string }[]>`SELECT count(*)::text as count FROM assets WHERE attempt_id = ${attemptBeforeCommit}`;
    expect(assetsPre.count).toBe('0');

    const recoveredPre = await completeLocalPanZoomAttempt(attemptBeforeCommit, { storage: storage });
    expect(recoveredPre.state).toBe('SUCCEEDED');

    const attemptAfterCommit = await admitLiveLocalAttempt(s);
    await expect(
      completeLocalPanZoomAttempt(attemptAfterCommit, {
        storage: storage,
        simulateCrashAt: 'AFTER_DB_COMMIT_BEFORE_ACK',
      }),
    ).rejects.toThrow('SIMULATED_CRASH_AFTER_DB_COMMIT_BEFORE_ACK');

    const redeliveryAfter = await completeLocalPanZoomAttempt(attemptAfterCommit, { storage: storage });
    expect(redeliveryAfter.state).toBe('SUCCEEDED');
    expect(redeliveryAfter.alreadyCompleted).toBe(true);

    const [assetsPost] = await pgClient<{ count: string }[]>`SELECT count(*)::text as count FROM assets WHERE attempt_id = ${attemptAfterCommit}`;
    expect(assetsPost.count).toBe('1');
    const [ledgerPost] = await pgClient<{ count: string }[]>`SELECT count(*)::text as count FROM cost_ledger_events WHERE attempt_id = ${attemptAfterCommit}`;
    expect(ledgerPost.count).toBe('2');
  });

  it('LP-AT-03: settles missing/corrupt START_FRAME on disk cleanly as FAILED before spawning FFmpeg', async () => {
    const s = await seedShotWithApprovedReplayKeyframe();
    const attemptId = await admitLiveLocalAttempt(s);
    await storage.delete('keyframes', `${s.pngSha}.png`);

    const res = await completeLocalPanZoomAttempt(attemptId, {
      storage: storage,
      renderOptions: { ffmpegBin: 'must-not-run' },
    });
    expect(res.state).toBe('FAILED');
    expect(res.errorCode).toBe('START_FRAME_MISSING');

    const [assetsCount] = await pgClient<{ count: string }[]>`SELECT count(*)::text as count FROM assets WHERE attempt_id = ${attemptId}`;
    expect(assetsCount.count).toBe('0');

    const [att] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${attemptId}`;
    expect(att.state).toBe('FAILED');

    const [fin] = await pgClient<{ billing_status: string; reservation_open_usd_micros: string }[]>`
      SELECT billing_status, reservation_open_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptId}
    `;
    expect(fin).toEqual({ billing_status: 'FINAL', reservation_open_usd_micros: '0' });

    const [outbox] = await pgClient<{ status: string; enqueue_outcome: string }[]>`
      SELECT status, enqueue_outcome FROM dispatch_outbox WHERE attempt_id = ${attemptId}
    `;
    expect(outbox).toEqual({ status: 'DELIVERED', enqueue_outcome: 'WORKER_CONFIRMED' });
  });

  it('LP-AT-05: preserves FAILED/CANCELED terminal states on duplicate delivery even when START_FRAME is missing', async () => {
    const s = await seedShotWithApprovedReplayKeyframe();
    const canceledAttemptId = await admitLiveLocalAttempt(s);
    const failedAttemptId = await admitLiveLocalAttempt(s);

    await storage.delete('keyframes', `${s.pngSha}.png`);
    await pgClient`UPDATE attempts SET state = 'CANCELED' WHERE id = ${canceledAttemptId}`;
    await pgClient`UPDATE attempts SET state = 'FAILED' WHERE id = ${failedAttemptId}`;

    const resCanceled = await completeLocalPanZoomAttempt(canceledAttemptId, {
      storage: storage,
      renderOptions: { ffmpegBin: 'must-not-run' },
    });
    expect(resCanceled).toEqual({
      attemptId: canceledAttemptId,
      state: 'CANCELED',
      alreadyCompleted: true,
      alreadyTerminal: true,
    });

    const resFailed = await completeLocalPanZoomAttempt(failedAttemptId, {
      storage: storage,
      renderOptions: { ffmpegBin: 'must-not-run' },
    });
    expect(resFailed).toEqual({
      attemptId: failedAttemptId,
      state: 'FAILED',
      alreadyCompleted: true,
      alreadyTerminal: true,
    });

    const [attC] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${canceledAttemptId}`;
    expect(attC.state).toBe('CANCELED');
    const [outboxC] = await pgClient<{ status: string; enqueue_outcome: string }[]>`
      SELECT status, enqueue_outcome FROM dispatch_outbox WHERE attempt_id = ${canceledAttemptId}
    `;
    expect(outboxC).toEqual({ status: 'DELIVERED', enqueue_outcome: 'WORKER_CONFIRMED' });
  });

  it('LP-AT-06: fails closed when existing Asset row on attempt_id conflicts in hash or startFrame lineage', async () => {
    const s = await seedShotWithApprovedReplayKeyframe();
    const attemptId = await admitLiveLocalAttempt(s);

    await pgClient`INSERT INTO assets(
      id, film_id, attempt_id, shot_revision_id, kind, storage_path, sha256_hash, mime_type, byte_size, verified, metadata
    ) VALUES (
      ${randomUUID()}, ${s.filmId}, ${attemptId}, ${s.shotRevisionId}, 'VIDEO',
      'videos/0000.mp4', ${'f'.repeat(64)}, 'video/mp4', '100', true,
      ${JSON.stringify({ provenance: 'LOCAL_PIPELINE', startFrameSha256: s.pngSha })}::jsonb
    )`;

    await expect(
      completeLocalPanZoomAttempt(attemptId, { storage: storage }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'CORRUPT_ASSET_HASH_MISMATCH',
    });

    const [att] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${attemptId}`;
    expect(att.state).toBe('QUEUED');
  });

  it('LP-AT-08: settles timeout and invalid ffprobe output cleanly as FAILED with zero Assets and clean temp', async () => {
    const s = await seedShotWithApprovedReplayKeyframe();
    const timeoutAttempt = await admitLiveLocalAttempt(s);
    const badProbeAttempt = await admitLiveLocalAttempt(s);

    const resTimeout = await completeLocalPanZoomAttempt(timeoutAttempt, {
      storage: storage,
      renderOptions: {
        ffmpegBin: process.execPath,
        ffmpegArgsOverride: ['-e', 'setTimeout(() => {}, 5000)'],
        timeoutMs: 80,
      },
    });
    expect(resTimeout.state).toBe('FAILED');
    expect(resTimeout.errorCode).toBe('LOCAL_RENDER_TIMEOUT');

    const badProbeJson = JSON.stringify({
      format: { format_name: 'mov,mp4', duration: '0.500000', size: '512' },
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, nb_frames: '15', pix_fmt: 'yuv420p' }],
    });
    const resInvalid = await completeLocalPanZoomAttempt(badProbeAttempt, {
      storage,
      renderOptions: {
        ffprobeBin: process.execPath,
        ffprobeArgsOverride: ['-e', `process.stdout.write(${JSON.stringify(badProbeJson)})`],
      },
    });
    expect(resInvalid.state).toBe('FAILED');
    expect(resInvalid.errorCode).toBe('LOCAL_OUTPUT_INVALID');

    const tempFiles = await fs.readdir(storage.resolveDir('temp'));
    expect(tempFiles).toEqual([]);

    const [assetCount] = await pgClient<{ count: string }[]>`
      SELECT count(*)::text as count FROM assets WHERE attempt_id IN (${timeoutAttempt}, ${badProbeAttempt})
    `;
    expect(assetCount.count).toBe('0');
  });
});

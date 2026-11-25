import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { shotAttemptDtoSchema } from '@nolen/contracts';
import { digest, unlock } from '../auth/sessions.js';
import { runtimeConfig } from '../config/runtime.js';
import { pgClient } from '../db/index.js';
import { migrateDatabase } from '../db/migrate.js';
import { createAssetApi } from '../http/asset-api.js';
import { createFinancialApi } from '../http/financial-api.js';
import { storage } from '../lib/storage.js';
import { fakeAssetProducer, storeAsset } from './repository.js';
import { Hono } from 'hono';

const token = 'assets-test-operator-token-at-least-32-bytes';
let cookie = '';

const app = new Hono();
app.route('/', createFinancialApi());
app.route('/', createAssetApi());

async function request(route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(`http://127.0.0.1:3000${route}`, {
    method,
    headers: {
      Origin: 'http://127.0.0.1:3000',
      Cookie: cookie,
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type FixtureOptions = {
  budget?: string;
  keyframePolicy?: 'REQUIRED' | 'OPTIONAL';
};

async function createFixture(opts: FixtureOptions = {}) {
  const budget = opts.budget ?? '10000000'; // 10 USD
  const keyframePolicy = opts.keyframePolicy ?? 'REQUIRED';

  const filmId = randomUUID();
  const storyRevisionId = randomUUID();
  const sceneId = randomUUID();
  const shotId = randomUUID();
  const shotRevisionId = randomUUID();
  const validationRunId = randomUUID();
  const imageRateId = randomUUID();
  const videoRateId = randomUUID();

  await pgClient.begin(async tx => {
    // 1. Film & Budget
    await tx`INSERT INTO films(id, title, brief, budget_limit_usd_micros, operator_id, idempotency_key, request_hash)
      VALUES(${filmId}, 'Asset Test Film', 'Keyframe test brief', ${budget}, 'local-operator', ${randomUUID()}, 'fixture')`;
    await tx`INSERT INTO film_budget_accounts(film_id, operator_id, budget_limit_usd_micros)
      VALUES(${filmId}, 'local-operator', ${budget})`;
    await tx`INSERT INTO budget_limit_events(id, film_id, actor_id, prior_limit_usd_micros, new_limit_usd_micros, reason)
      VALUES(${randomUUID()}, ${filmId}, 'local-operator', ${budget}, ${budget}, 'test baseline')`;

    // 2. Story Revision (Approved)
    await tx`INSERT INTO story_revisions(id, film_id, revision_no, state, content, content_hash)
      VALUES(${storyRevisionId}, ${filmId}, 1, 'APPROVED', '{"title":"Test"}'::jsonb, 'fixture-content-hash')`;
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
      VALUES(${shotRevisionId}, ${filmId}, ${shotId}, '{"prompt":"Hero walking"}'::jsonb, 'dep-hash-1', ${JSON.stringify({ effectiveRequirement: keyframePolicy })}::jsonb)`;
    await tx`INSERT INTO story_revision_shots(film_id, story_revision_id, scene_id, shot_id, shot_revision_id, position)
      VALUES(${filmId}, ${storyRevisionId}, ${sceneId}, ${shotId}, ${shotRevisionId}, 1)`;

    // 4. Rate Cards for IMAGE and VIDEO
    await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
      VALUES(${imageRateId}, 'google', 'gemini-3.1-flash-image', 'IMAGE', 'FIXED_PER_REQUEST', 200000, '2026-01-01', '2027-01-01', 'google-rate-snapshot')`;
    await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
      VALUES(${videoRateId}, 'runway', 'gen4_turbo', 'VIDEO', 'PER_SECOND', 500000, '2026-01-01', '2027-01-01', 'runway-rate-snapshot')`;
  });

  return {
    filmId,
    storyRevisionId,
    sceneId,
    shotId,
    shotRevisionId,
    imageRateId,
    videoRateId,
  };
}

beforeAll(async () => {
  process.env.OPERATOR_TOKEN = token;
  await migrateDatabase(process.env.DATABASE_URL!);
  cookie = `nolen_session=${await unlock(token)}`;
});

afterAll(async () => {
  await pgClient.end();
});

describe('EP-03 / KF-001: Keyframe Approval Gate & Asset Lifecycle', () => {
  it('KF-AT-01: Asset registration & content-addressed storage', async () => {
    const f = await createFixture();
    const attemptId = randomUUID();

    // Create attempt row for the asset
    await pgClient`INSERT INTO attempts(id, film_id, story_revision_id, shot_revision_id, kind, provider, model, rate_card_snapshot_id, pricing_units, reservation_usd_micros)
      VALUES(${attemptId}, ${f.filmId}, ${f.storyRevisionId}, ${f.shotRevisionId}, 'IMAGE', 'google', 'gemini-3.1-flash-image', ${f.imageRateId}, 1, 200000)`;

    const pngBuffer = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    const asset = await storeAsset({
      filmId: f.filmId,
      attemptId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      buffer: pngBuffer,
      mimeType: 'image/png',
      metadata: { seed: 42 },
    });

    expect(asset.id).toBeDefined();
    expect(asset.filmId).toBe(f.filmId);
    expect(asset.shotRevisionId).toBe(f.shotRevisionId);
    expect(asset.kind).toBe('IMAGE');
    expect(asset.mediaUrl).toBe(`/api/assets/${asset.id}/media`);
    expect(asset.byteSize).toBe(String(pngBuffer.length));
    expect(asset.sha256Hash).toMatch(/^[a-f0-9]{64}$/);

    // Verify row in DB
    const [dbRow] = await pgClient`SELECT * FROM assets WHERE id = ${asset.id}`;
    expect(dbRow).toBeDefined();
    expect(dbRow.sha256_hash).toBe(asset.sha256Hash);

    // Verify uniqueness of attempt_id
    await expect(
      storeAsset({
        filmId: f.filmId,
        attemptId,
        shotRevisionId: f.shotRevisionId,
        kind: 'IMAGE',
        buffer: pngBuffer,
        mimeType: 'image/png',
      }),
    ).rejects.toThrow('Asset already exists for this attempt');
  });

  it('KF-AT-02: Deterministic review & video admission gating (Approval Path)', async () => {
    const f = await createFixture();

    // 1. Admit keyframe (IMAGE) attempt
    const imgKey = randomUUID();
    const imgRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': imgKey });
    expect(imgRes.status).toBe(201);
    const { attemptId: imgAttemptId } = await imgRes.json() as { attemptId: string };

    // 2. Synthesize keyframe asset via fakeAssetProducer
    const keyframeAsset = await fakeAssetProducer({
      filmId: f.filmId,
      attemptId: imgAttemptId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
    });

    // 3. Try to dispatch VIDEO attempt before keyframe approval -> must fail with 409
    const vidKey1 = randomUUID();
    const vidResBefore = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: f.videoRateId,
      pricingUnits: 5,
    }, { 'Idempotency-Key': vidKey1 });
    expect(vidResBefore.status).toBe(409);
    const errBody = await vidResBefore.json() as { error: { code: string } };
    expect(errBody.error.code).toBe('KEYFRAME_APPROVAL_REQUIRED');

    // 4. Submit APPROVED review
    const reviewRes = await request(`/api/assets/${keyframeAsset.id}/review`, 'POST', {
      decision: 'APPROVED',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
      reason: 'Perfect frame composition',
    });
    expect(reviewRes.status).toBe(200);
    const reviewData = await reviewRes.json() as { decision: string; selection: { assetId: string } };
    expect(reviewData.decision).toBe('APPROVED');
    expect(reviewData.selection.assetId).toBe(keyframeAsset.id);

    // Verify shot_asset_selections in DB
    const [selectionRow] = await pgClient`
      SELECT * FROM shot_asset_selections
      WHERE story_revision_id = ${f.storyRevisionId} AND shot_id = ${f.shotId} AND kind = 'IMAGE'
    `;
    expect(selectionRow).toBeDefined();
    expect(selectionRow.asset_id).toBe(keyframeAsset.id);

    // 5. Try to dispatch VIDEO attempt now -> must succeed (201 QUEUED)
    const vidKey2 = randomUUID();
    const vidResAfter = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: f.videoRateId,
      pricingUnits: 5,
    }, { 'Idempotency-Key': vidKey2 });
    expect(vidResAfter.status).toBe(201);
  });

  it('KF-AT-03: Rejection flow & mandatory reason', async () => {
    const f = await createFixture();

    const imgKey = randomUUID();
    const imgRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': imgKey });
    const { attemptId: imgAttemptId } = await imgRes.json() as { attemptId: string };

    const keyframeAsset = await fakeAssetProducer({
      filmId: f.filmId,
      attemptId: imgAttemptId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
    });

    // 1. REJECT without reason -> contract validation error (422 VALIDATION_ERROR)
    const badRejectRes = await request(`/api/assets/${keyframeAsset.id}/review`, 'POST', {
      decision: 'REJECTED',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
    });
    expect(badRejectRes.status).toBe(422);
    const badRejectBody = await badRejectRes.json() as { error: { code: string; details?: { reason?: string[] } } };
    expect(badRejectBody.error.code).toBe('VALIDATION_ERROR');
    expect(badRejectBody.error.details?.reason).toBeDefined();

    // 2. First APPROVE the asset
    await request(`/api/assets/${keyframeAsset.id}/review`, 'POST', {
      decision: 'APPROVED',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
    });

    // 3. Now REJECT it with reason (expectedReviewCount: 1)
    const rejectRes = await request(`/api/assets/${keyframeAsset.id}/review`, 'POST', {
      decision: 'REJECTED',
      reason: 'Character face is warped',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 1,
    });
    expect(rejectRes.status).toBe(200);

    // 4. Selection must be removed
    const selections = await pgClient`
      SELECT * FROM shot_asset_selections
      WHERE story_revision_id = ${f.storyRevisionId} AND shot_id = ${f.shotId} AND kind = 'IMAGE'
    `;
    expect(selections).toHaveLength(0);

    // 5. Video admission must be blocked again
    const vidRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: f.videoRateId,
      pricingUnits: 5,
    }, { 'Idempotency-Key': randomUUID() });
    expect(vidRes.status).toBe(409);
    expect(((await vidRes.json()) as { error: { code: string } }).error.code).toBe('KEYFRAME_APPROVAL_REQUIRED');
  });

  it('KF-AT-04: Revision drift invalidates prior keyframe', async () => {
    const f = await createFixture();

    // Setup approved keyframe for shot revision 1
    const imgKey = randomUUID();
    const imgRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': imgKey });
    const { attemptId } = await imgRes.json() as { attemptId: string };
    const keyframe = await fakeAssetProducer({ filmId: f.filmId, attemptId, shotRevisionId: f.shotRevisionId });
    await request(`/api/assets/${keyframe.id}/review`, 'POST', {
      decision: 'APPROVED',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
    });

    // Video for ShotRevision 1 is admitted
    const vidRes1 = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: f.videoRateId,
      pricingUnits: 5,
    }, { 'Idempotency-Key': randomUUID() });
    expect(vidRes1.status).toBe(201);

    // Create a new StoryRevision 2 with new ShotRevision 2 for the same shot
    const storyRev2Id = randomUUID();
    const shotRev2Id = randomUUID();
    const val2Id = randomUUID();

    await pgClient.begin(async tx => {
      await tx`INSERT INTO story_revisions(id, film_id, parent_id, revision_no, state, content, content_hash)
        VALUES(${storyRev2Id}, ${f.filmId}, ${f.storyRevisionId}, 2, 'APPROVED', '{"title":"Rev2"}'::jsonb, 'content-hash-2')`;
      await tx`UPDATE films SET active_story_revision_id=${storyRev2Id} WHERE id=${f.filmId}`;

      await tx`INSERT INTO story_validations(id, story_revision_id, context, dependency_hash, rule_set_version, findings)
        VALUES(${val2Id}, ${storyRev2Id}, 'STORY_APPROVAL', 'dep-2', 'story-approval-2', '[]'::jsonb)`;
      await tx`INSERT INTO story_approvals(id, story_revision_id, evidence)
        VALUES(${randomUUID()}, ${storyRev2Id}, ${JSON.stringify({
          storyRevisionId: storyRev2Id,
          contentHash: 'content-hash-2',
          dependencyHash: 'dep-2',
          ruleSetVersion: 'story-approval-2',
          validationRunId: val2Id,
          waiverIds: [],
          waiverSetHash: 'fixture-waivers-2',
          actorId: 'local-operator',
          approvedAt: new Date().toISOString(),
          decision: 'APPROVED',
        })}::jsonb)`;

      await tx`INSERT INTO story_revision_scenes(film_id, story_revision_id, scene_id, position)
        VALUES(${f.filmId}, ${storyRev2Id}, ${f.sceneId}, 1)`;
      await tx`INSERT INTO shot_revisions(id, film_id, shot_id, spec, dependency_hash, policy)
        VALUES(${shotRev2Id}, ${f.filmId}, ${f.shotId}, '{"prompt":"Hero running"}'::jsonb, 'dep-hash-2', '{"effectiveRequirement":"REQUIRED"}'::jsonb)`;
      await tx`INSERT INTO story_revision_shots(film_id, story_revision_id, scene_id, shot_id, shot_revision_id, position)
        VALUES(${f.filmId}, ${storyRev2Id}, ${f.sceneId}, ${f.shotId}, ${shotRev2Id}, 1)`;
    });

    // Attempting video dispatch for ShotRevision 2 in StoryRevision 2 must fail (keyframe from rev 1 is stale)
    const vidRes2 = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: storyRev2Id,
      shotRevisionId: shotRev2Id,
      kind: 'VIDEO',
      rateCardSnapshotId: f.videoRateId,
      pricingUnits: 5,
    }, { 'Idempotency-Key': randomUUID() });
    expect(vidRes2.status).toBe(409);
    expect(((await vidRes2.json()) as { error: { code: string } }).error.code).toBe('KEYFRAME_APPROVAL_REQUIRED');
  });

  it('KF-AT-05: Concurrency serialization & lock ordering (Barrier test)', async () => {
    const f = await createFixture();

    // Lock film row in an open transaction
    let unlockFilm!: () => void;
    const filmLocked = new Promise<void>(resolve => {
      unlockFilm = resolve;
    });

    let filmLockAcquired!: () => void;
    const lockAcquiredPromise = new Promise<void>(resolve => {
      filmLockAcquired = resolve;
    });

    const lockPromise = pgClient.begin(async tx => {
      await tx`SELECT id FROM films WHERE id = ${f.filmId} FOR UPDATE`;
      filmLockAcquired();
      await filmLocked;
    });

    await lockAcquiredPromise;

    // Start admitAttempt in background
    const admitPromise = request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': randomUUID() });

    // Wait until admitAttempt is observed waiting on the film lock via pg_blocking_pids
    let blocked = false;
    for (let i = 0; i < 50; i++) {
      const rows = await pgClient<{ blocked_pid: number; blocking_pid: number }[]>`
        SELECT pid AS blocked_pid, unnest(pg_blocking_pids(pid)) AS blocking_pid
        FROM pg_stat_activity
        WHERE query LIKE '%FOR UPDATE OF f%'
      `;
      if (rows.length > 0) {
        blocked = true;
        break;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    expect(blocked).toBe(true);

    // Release film lock
    unlockFilm();
    await lockPromise;

    const res = await admitPromise;
    expect(res.status).toBe(201);
  });

  it('KF-AT-06: Optimistic concurrency conflict on review (expectedReviewCount)', async () => {
    const f = await createFixture();

    const imgRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': randomUUID() });
    const { attemptId } = await imgRes.json() as { attemptId: string };
    const asset = await fakeAssetProducer({ filmId: f.filmId, attemptId, shotRevisionId: f.shotRevisionId });

    // Review 1 (expectedReviewCount = 0) -> 200 OK
    const r1 = await request(`/api/assets/${asset.id}/review`, 'POST', {
      decision: 'APPROVED',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
    });
    expect(r1.status).toBe(200);

    // Review 2 with stale expectedReviewCount = 0 -> 409 VERSION_CONFLICT
    const r2 = await request(`/api/assets/${asset.id}/review`, 'POST', {
      decision: 'REJECTED',
      reason: 'Should conflict',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
    });
    expect(r2.status).toBe(409);
    expect(((await r2.json()) as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT');
  });

  it('KF-AT-07: Shot revision mismatch rejection', async () => {
    const f = await createFixture();

    const imgRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': randomUUID() });
    const { attemptId } = await imgRes.json() as { attemptId: string };
    const asset = await fakeAssetProducer({ filmId: f.filmId, attemptId, shotRevisionId: f.shotRevisionId });

    // Review with arbitrary/different shot revision ID -> 409 ASSET_SHOT_REVISION_MISMATCH
    const mismatchRes = await request(`/api/assets/${asset.id}/review`, 'POST', {
      decision: 'APPROVED',
      expectedShotRevisionId: randomUUID(),
      expectedReviewCount: 0,
    });
    expect(mismatchRes.status).toBe(409);
    expect(((await mismatchRes.json()) as { error: { code: string } }).error.code).toBe('ASSET_SHOT_REVISION_MISMATCH');
  });

  it('KF-AT-08: Media streaming & containment', async () => {
    const f = await createFixture();

    const imgRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': randomUUID() });
    const { attemptId } = await imgRes.json() as { attemptId: string };
    const asset = await fakeAssetProducer({ filmId: f.filmId, attemptId, shotRevisionId: f.shotRevisionId });

    // Fetch media via HTTP
    const mediaRes = await request(`/api/assets/${asset.id}/media`);
    expect(mediaRes.status).toBe(200);
    expect(mediaRes.headers.get('content-type')).toBe('image/png');
    expect(mediaRes.headers.get('content-length')).toBe(asset.byteSize);
    expect(mediaRes.headers.get('etag')).toBe(`"${asset.sha256Hash}"`);
    expect(mediaRes.headers.get('cache-control')).toBe('private, max-age=86400');

    const bytes = new Uint8Array(await mediaRes.arrayBuffer());
    expect(bytes.length).toBe(parseInt(asset.byteSize, 10));

    // Path traversal containment check
    expect(() => storage.resolve('keyframes', '../../etc/passwd')).toThrow('Path containment violation');
  });

  it('KF-AT-09: Optional keyframe shot policy', async () => {
    // Shot revision with OPTIONAL keyframe requirement
    const f = await createFixture({ keyframePolicy: 'OPTIONAL' });

    // 1. Dispatching image-driven VIDEO attempt without keyframe must be rejected with 409 KEYFRAME_APPROVAL_REQUIRED
    const vidResBefore = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: f.videoRateId,
      pricingUnits: 5,
    }, { 'Idempotency-Key': randomUUID() });
    expect(vidResBefore.status).toBe(409);
    const errBody = await vidResBefore.json() as { error?: { code: string } };
    expect(errBody.error?.code).toBe('KEYFRAME_APPROVAL_REQUIRED');

    // 2. Synthesize and approve keyframe
    const imgKey = randomUUID();
    const imgRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': imgKey });
    expect(imgRes.status).toBe(201);
    const { attemptId: imgAttemptId } = await imgRes.json() as { attemptId: string };

    const keyframeAsset = await fakeAssetProducer({
      filmId: f.filmId,
      attemptId: imgAttemptId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
    });

    await request(`/api/assets/${keyframeAsset.id}/review`, 'POST', {
      decision: 'APPROVED',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
      reason: 'Approved keyframe for optional shot',
    });

    // 3. Dispatching VIDEO attempt with approved keyframe succeeds
    const vidRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: f.videoRateId,
      pricingUnits: 5,
    }, { 'Idempotency-Key': randomUUID() });
    expect(vidRes.status).toBe(201);
  });

  it('KF-AT-10: Fake asset producer isolation', async () => {
    const f = await createFixture();

    const imgRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
      executionMode: 'LIVE',
    }, { 'Idempotency-Key': randomUUID() });
    const { attemptId } = await imgRes.json() as { attemptId: string };

    const ledgerBefore = await pgClient`SELECT * FROM cost_ledger_events WHERE film_id = ${f.filmId}`;
    expect(ledgerBefore).toHaveLength(1); // RESERVATION_CREATED from attempt admission

    // Generate fake asset
    const asset = await fakeAssetProducer({ filmId: f.filmId, attemptId, shotRevisionId: f.shotRevisionId });
    expect(asset.id).toBeDefined();

    // Verify no additional financial ledger events were created by the fake asset producer
    const ledgerAfter = await pgClient`SELECT * FROM cost_ledger_events WHERE film_id = ${f.filmId}`;
    expect(ledgerAfter).toHaveLength(1);
  });

  it('KF-BLOCK-1: Missing or tampered asset file fails closed with INTEGRITY_CHECK_FAILED', async () => {
    const f = await createFixture();

    const imgRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': randomUUID() });
    const { attemptId } = await imgRes.json() as { attemptId: string };
    const asset = await fakeAssetProducer({ filmId: f.filmId, attemptId, shotRevisionId: f.shotRevisionId });

    const filename = `${asset.sha256Hash}.png`;

    // 1A. Tamper with the file before review
    const originalFile = await storage.read('keyframes', filename);
    await storage.write('keyframes', filename, Buffer.from('corrupted data'));

    const tamperReviewRes = await request(`/api/assets/${asset.id}/review`, 'POST', {
      decision: 'APPROVED',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
    });
    expect(tamperReviewRes.status).toBe(422);
    expect(((await tamperReviewRes.json()) as { error: { code: string } }).error.code).toBe('INTEGRITY_CHECK_FAILED');

    // 1B. Delete the file before review
    await storage.delete('keyframes', filename);
    const missingReviewRes = await request(`/api/assets/${asset.id}/review`, 'POST', {
      decision: 'APPROVED',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
    });
    expect(missingReviewRes.status).toBe(422);
    expect(((await missingReviewRes.json()) as { error: { code: string } }).error.code).toBe('INTEGRITY_CHECK_FAILED');

    // Restore original file and approve
    await storage.write('keyframes', filename, originalFile);
    const approveRes = await request(`/api/assets/${asset.id}/review`, 'POST', {
      decision: 'APPROVED',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
    });
    expect(approveRes.status).toBe(200);

    // 1C. Tamper with file AFTER approval, then attempt VIDEO dispatch
    await storage.write('keyframes', filename, Buffer.from('post-approval tampering'));
    const tamperVidRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: f.videoRateId,
      pricingUnits: 5,
    }, { 'Idempotency-Key': randomUUID() });
    expect(tamperVidRes.status).toBe(409);
    expect(((await tamperVidRes.json()) as { error: { code: string } }).error.code).toBe('INTEGRITY_CHECK_FAILED');

    // 1D. Delete file AFTER approval, then attempt VIDEO dispatch
    await storage.delete('keyframes', filename);
    const missingVidRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: f.videoRateId,
      pricingUnits: 5,
    }, { 'Idempotency-Key': randomUUID() });
    expect(missingVidRes.status).toBe(409);
    expect(((await missingVidRes.json()) as { error: { code: string } }).error.code).toBe('INTEGRITY_CHECK_FAILED');

    // Restore file and verify VIDEO dispatch succeeds
    await storage.write('keyframes', filename, originalFile);
    const validVidRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: f.videoRateId,
      pricingUnits: 5,
    }, { 'Idempotency-Key': randomUUID() });
    expect(validVidRes.status).toBe(201);
  });

  it('KF-BLOCK-2: Media download requires operator authentication and film ownership', async () => {
    const f = await createFixture();

    const imgRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': randomUUID() });
    const { attemptId } = await imgRes.json() as { attemptId: string };
    const asset = await fakeAssetProducer({ filmId: f.filmId, attemptId, shotRevisionId: f.shotRevisionId });

    // 2A. Unauthenticated request (no Cookie header)
    const unauthRes = await request(`/api/assets/${asset.id}/media`, 'GET', undefined, { Cookie: '' });
    expect(unauthRes.status).toBe(401);
    expect(((await unauthRes.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');

    // 2B. Authenticated as a foreign operator
    const foreignSessionId = randomBytes(32).toString('base64url');
    await pgClient`
      INSERT INTO operator_sessions (session_hash, operator_id, token_fingerprint, expires_at)
      VALUES (${digest(foreignSessionId)}, 'foreign-operator', ${runtimeConfig().fingerprint}, NOW() + INTERVAL '1 hour')
    `;
    const foreignCookie = `nolen_session=${foreignSessionId}`;

    const foreignRes = await request(`/api/assets/${asset.id}/media`, 'GET', undefined, { Cookie: foreignCookie });
    expect(foreignRes.status).toBe(404);
    expect(((await foreignRes.json()) as { error: { code: string } }).error.code).toBe('ASSET_NOT_FOUND');

    // 2C. Authorized operator succeeds
    const authRes = await request(`/api/assets/${asset.id}/media`);
    expect(authRes.status).toBe(200);
  });

  it('KF-BLOCK-3: storeAsset enforces attempt provenance and composite foreign key rejects tampering', async () => {
    const f = await createFixture();

    const imgRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': randomUUID() });
    const { attemptId } = await imgRes.json() as { attemptId: string };

    const validPngBuffer = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
      'hex',
    );

    // 3A. Caller passes mismatched filmId
    await expect(
      storeAsset({
        filmId: randomUUID(),
        attemptId,
        shotRevisionId: f.shotRevisionId,
        kind: 'IMAGE',
        buffer: validPngBuffer,
        mimeType: 'image/png',
      }),
    ).rejects.toThrow('filmId does not match attempt provenance');

    // 3B. Caller passes mismatched shotRevisionId
    await expect(
      storeAsset({
        filmId: f.filmId,
        attemptId,
        shotRevisionId: randomUUID(),
        kind: 'IMAGE',
        buffer: validPngBuffer,
        mimeType: 'image/png',
      }),
    ).rejects.toThrow('shotRevisionId does not match attempt provenance');

    // 3C. Caller passes mismatched kind
    await expect(
      storeAsset({
        filmId: f.filmId,
        attemptId,
        shotRevisionId: f.shotRevisionId,
        kind: 'VIDEO',
        buffer: validPngBuffer,
        mimeType: 'image/png',
      }),
    ).rejects.toThrow('kind does not match attempt provenance');

    // 3D. Direct raw DB insert with mismatched (film_id, shot_revision_id, kind, attempt_id) violates composite FK
    const dummyAssetId = randomUUID();
    const otherShotRevId = randomUUID();
    await expect(
      pgClient`
        INSERT INTO assets (
          id, film_id, attempt_id, shot_revision_id, kind,
          storage_path, sha256_hash, mime_type, byte_size, verified
        ) VALUES (
          ${dummyAssetId}, ${f.filmId}, ${attemptId}, ${otherShotRevId}, 'IMAGE',
          'keyframes/dummy.png', 'fakehash', 'image/png', 100, true
        )
      `,
    ).rejects.toThrow();
  });

  it('KF-BLOCK-4: asset_reviews is strictly append-only (UPDATE and DELETE rejected by trigger)', async () => {
    const f = await createFixture();

    const imgRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': randomUUID() });
    const { attemptId } = await imgRes.json() as { attemptId: string };
    const asset = await fakeAssetProducer({ filmId: f.filmId, attemptId, shotRevisionId: f.shotRevisionId });

    const reviewRes = await request(`/api/assets/${asset.id}/review`, 'POST', {
      decision: 'APPROVED',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
    });
    expect(reviewRes.status).toBe(200);
    const { reviewId } = await reviewRes.json() as { reviewId: string };

    // 4A. Direct UPDATE on asset_reviews is rejected
    await expect(
      pgClient`UPDATE asset_reviews SET decision = 'REJECTED' WHERE id = ${reviewId}`,
    ).rejects.toThrow('KF_APPEND_ONLY');

    // 4B. Direct DELETE on asset_reviews is rejected
    await expect(
      pgClient`DELETE FROM asset_reviews WHERE id = ${reviewId}`,
    ).rejects.toThrow('KF_APPEND_ONLY');
  });

  it('KF-BLOCK-5: Selection and review cannot link an asset to a mismatched shot revision or kind', async () => {
    const f = await createFixture();

    // Setup Shot B in the same story revision
    const shotBId = randomUUID();
    const shotRevBId = randomUUID();
    await pgClient.begin(async tx => {
      await tx`INSERT INTO shots(id, film_id) VALUES(${shotBId}, ${f.filmId})`;
      await tx`INSERT INTO shot_revisions(id, film_id, shot_id, spec, dependency_hash, policy)
        VALUES(${shotRevBId}, ${f.filmId}, ${shotBId}, '{"prompt":"Shot B"}'::jsonb, 'dep-b', '{"effectiveRequirement":"REQUIRED"}'::jsonb)`;
      await tx`INSERT INTO story_revision_shots(film_id, story_revision_id, scene_id, shot_id, shot_revision_id, position)
        VALUES(${f.filmId}, ${f.storyRevisionId}, ${f.sceneId}, ${shotBId}, ${shotRevBId}, 2)`;
    });

    // Create and approve image keyframe asset for Shot A
    const imgResA = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': randomUUID() });
    const { attemptId: attemptAId } = await imgResA.json() as { attemptId: string };
    const assetA = await fakeAssetProducer({ filmId: f.filmId, attemptId: attemptAId, shotRevisionId: f.shotRevisionId });

    await request(`/api/assets/${assetA.id}/review`, 'POST', {
      decision: 'APPROVED',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
    });

    // 5A. Direct insert into asset_reviews with assetA but shotRevBId must be rejected by composite FK
    await expect(
      pgClient`
        INSERT INTO asset_reviews (id, asset_id, film_id, shot_revision_id, actor_id, decision, reason)
        VALUES (${randomUUID()}, ${assetA.id}, ${f.filmId}, ${shotRevBId}, 'local-operator', 'APPROVED', '')
      `,
    ).rejects.toThrow();

    // 5B. Direct insert into shot_asset_selections for Shot B with assetA and shotRevBId must be rejected by composite FK
    await expect(
      pgClient`
        INSERT INTO shot_asset_selections (story_revision_id, shot_id, kind, shot_revision_id, asset_id, film_id, selected_by)
        VALUES (${f.storyRevisionId}, ${shotBId}, 'IMAGE', ${shotRevBId}, ${assetA.id}, ${f.filmId}, 'local-operator')
      `,
    ).rejects.toThrow();

    // 5C. Direct insert into shot_asset_selections with mismatched kind ('VIDEO' for image asset) must be rejected by composite FK
    await expect(
      pgClient`
        INSERT INTO shot_asset_selections (story_revision_id, shot_id, kind, shot_revision_id, asset_id, film_id, selected_by)
        VALUES (${f.storyRevisionId}, ${f.shotId}, 'VIDEO', ${f.shotRevisionId}, ${assetA.id}, ${f.filmId}, 'local-operator')
      `,
    ).rejects.toThrow();

    // 5D. VIDEO admission for Shot B must fail with KEYFRAME_APPROVAL_REQUIRED (Shot A's keyframe cannot unlock Shot B)
    const vidResB = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: shotRevBId,
      kind: 'VIDEO',
      rateCardSnapshotId: f.videoRateId,
      pricingUnits: 5,
    }, { 'Idempotency-Key': randomUUID() });
    expect(vidResB.status).toBe(409);
    expect(((await vidResB.json()) as { error: { code: string } }).error.code).toBe('KEYFRAME_APPROVAL_REQUIRED');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EP-05: Shot Asset Selection & Attempts History Integration
  // ─────────────────────────────────────────────────────────────────────────
  it('EP-05: selectShotAsset selects approved asset and rejects non-approved or mismatched asset', async () => {
    const f = await createFixture();

    // 1. Admit Attempt 1 and produce Asset 1
    const img1Res = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': randomUUID() });
    const { attemptId: att1Id } = await img1Res.json() as { attemptId: string };
    const asset1 = await fakeAssetProducer({ filmId: f.filmId, attemptId: att1Id, shotRevisionId: f.shotRevisionId });

    // Approve Asset 1
    await request(`/api/assets/${asset1.id}/review`, 'POST', {
      decision: 'APPROVED',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
    });

    // 2. Admit Attempt 2 and produce Asset 2
    const img2Res = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': randomUUID() });
    const { attemptId: att2Id } = await img2Res.json() as { attemptId: string };
    const asset2 = await fakeAssetProducer({ filmId: f.filmId, attemptId: att2Id, shotRevisionId: f.shotRevisionId });

    // Approve Asset 2 -> by default reviewAsset automatically selects the newly approved asset
    await request(`/api/assets/${asset2.id}/review`, 'POST', {
      decision: 'APPROVED',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
    });

    // 3. Admit Attempt 3 and produce Asset 3, then REJECT it
    const img3Res = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
    }, { 'Idempotency-Key': randomUUID() });
    const { attemptId: att3Id } = await img3Res.json() as { attemptId: string };
    const asset3 = await fakeAssetProducer({ filmId: f.filmId, attemptId: att3Id, shotRevisionId: f.shotRevisionId });

    await request(`/api/assets/${asset3.id}/review`, 'POST', {
      decision: 'REJECTED',
      reason: 'Lighting is too dark',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
    });

    // Verify Asset 2 is currently selected
    const assetsInitial = await (await request(`/api/films/${f.filmId}/shots/${f.shotId}/assets`, 'GET')).json() as { id: string; isSelected: boolean }[];
    const a2 = assetsInitial.find(a => a.id === asset2.id);
    const a1 = assetsInitial.find(a => a.id === asset1.id);
    expect(a2?.isSelected).toBe(true);
    expect(a1?.isSelected).toBe(false);

    // Switch selection back to Asset 1 via POST /api/films/:id/shots/:shotId/selections
    const selectRes = await request(`/api/films/${f.filmId}/shots/${f.shotId}/selections`, 'POST', {
      assetId: asset1.id,
      kind: 'IMAGE',
    });
    expect(selectRes.status).toBe(200);
    const selJson = await selectRes.json() as { assetId: string; reviewDecision: string; kind: string };
    expect(selJson.assetId).toBe(asset1.id);
    expect(selJson.reviewDecision).toBe('APPROVED');

    // Verify Asset 1 is now selected, Asset 2 is unselected
    const assetsUpdated = await (await request(`/api/films/${f.filmId}/shots/${f.shotId}/assets`, 'GET')).json() as { id: string; isSelected: boolean }[];
    expect(assetsUpdated.find(a => a.id === asset1.id)?.isSelected).toBe(true);
    expect(assetsUpdated.find(a => a.id === asset2.id)?.isSelected).toBe(false);

    // Attempting to select rejected Asset 3 must fail with 422 ASSET_NOT_APPROVED
    const rejSelectRes = await request(`/api/films/${f.filmId}/shots/${f.shotId}/selections`, 'POST', {
      assetId: asset3.id,
      kind: 'IMAGE',
    });
    expect(rejSelectRes.status).toBe(422);
    expect(((await rejSelectRes.json()) as { error: { code: string } }).error.code).toBe('ASSET_NOT_APPROVED');

    // Attempting to select with mismatched kind (e.g. VIDEO for image asset) must fail with 422 ASSET_KIND_MISMATCH
    const misKindRes = await request(`/api/films/${f.filmId}/shots/${f.shotId}/selections`, 'POST', {
      assetId: asset1.id,
      kind: 'VIDEO',
    });
    expect(misKindRes.status).toBe(422);
    expect(((await misKindRes.json()) as { error: { code: string } }).error.code).toBe('ASSET_KIND_MISMATCH');
  });

  it('EP-05: getShotAttempts returns all attempts for the shot with status, asset link and selection state', async () => {
    const f = await createFixture();

    // 1. Admit Attempt 1 (IMAGE)
    const imgRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    }, { 'Idempotency-Key': randomUUID() });
    const { attemptId: att1Id } = await imgRes.json() as { attemptId: string };
    const asset1 = await fakeAssetProducer({ filmId: f.filmId, attemptId: att1Id, shotRevisionId: f.shotRevisionId });

    await request(`/api/assets/${asset1.id}/review`, 'POST', {
      decision: 'APPROVED',
      expectedShotRevisionId: f.shotRevisionId,
      expectedReviewCount: 0,
    });

    // 2. Also admit attempts and transition them to SUBMITTED and SUBMISSION_UNCERTAIN
    const subRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    }, { 'Idempotency-Key': randomUUID() });
    expect(subRes.status).toBe(201);
    const { attemptId: submittedId } = await subRes.json() as { attemptId: string };
    await pgClient`UPDATE attempts SET state = 'SUBMITTED' WHERE id = ${submittedId}`;

    const uncRes = await request(`/api/films/${f.filmId}/attempts`, 'POST', {
      storyRevisionId: f.storyRevisionId,
      shotRevisionId: f.shotRevisionId,
      kind: 'IMAGE',
      rateCardSnapshotId: f.imageRateId,
      pricingUnits: 1,
      executionMode: 'REPLAY',
    }, { 'Idempotency-Key': randomUUID() });
    expect(uncRes.status).toBe(201);
    const { attemptId: uncertainId } = await uncRes.json() as { attemptId: string };
    await pgClient`UPDATE attempts SET state = 'SUBMISSION_UNCERTAIN' WHERE id = ${uncertainId}`;

    // 3. Query attempts endpoint and parse entire response with shared shotAttemptDtoSchema
    const attemptsRes = await request(`/api/films/${f.filmId}/shots/${f.shotId}/attempts`, 'GET');
    expect(attemptsRes.status).toBe(200);
    const attempts = z.array(shotAttemptDtoSchema).parse(await attemptsRes.json());

    expect(attempts.length).toBeGreaterThanOrEqual(3);
    const found = attempts.find(a => a.id === att1Id);
    expect(found).toBeDefined();
    expect(found?.kind).toBe('IMAGE');
    expect(found?.executionMode).toBe('REPLAY');
    expect(found?.assetId).toBe(asset1.id);
    expect(found?.latestReviewDecision).toBe('APPROVED');
    expect(found?.isSelected).toBe(true);

    expect(attempts.find(a => a.id === submittedId)?.state).toBe('SUBMITTED');
    expect(attempts.find(a => a.id === uncertainId)?.state).toBe('SUBMISSION_UNCERTAIN');
  });
});

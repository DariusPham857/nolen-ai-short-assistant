import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { canonicalStoryV2 } from '@nolen/contracts';
import { pgClient } from '../servers/src/db/index.js';
import { migrateDatabase } from '../servers/src/db/migrate.js';
import { completeLiveAttempt } from '../servers/src/dispatch/live-completion.js';
import { admitAttempt, auditFinancialProjection, previewGeneration } from '../servers/src/financial/repository.js';

function assertAttestation(): void {
  if (process.env.LIVE_BILLING_ATTESTED !== 'true') {
    throw new Error('LIVE_BILLING_ATTESTED must equal "true" to run live paid canary calls');
  }
  if (!process.env.GEMINI_API_KEY?.trim()) {
    throw new Error('GEMINI_API_KEY is required for PD-AT-01b canary');
  }
  if (!process.env.RUNWAY_API_KEY?.trim()) {
    throw new Error('RUNWAY_API_KEY is required for PD-AT-02b canary');
  }
}

async function waitForProducerApproval(
  filmId: string,
  assetId: string,
  shotRevisionId: string,
  shotId: string,
  storyRevisionId: string,
  storagePath: string,
  sha256: string,
  waitUiMode: boolean,
): Promise<boolean> {
  console.log('\n[canary] Generated Gemini Keyframe (PENDING_REVIEW):');
  console.log(JSON.stringify({ assetId, storagePath, sha256 }, null, 2));

  if (waitUiMode) {
    console.log('[canary] Waiting for producer AssetReview decision via UI/API...');
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      const [review] = await pgClient<{ decision: string }[]>`
        SELECT decision FROM asset_reviews
        WHERE film_id = ${filmId} AND asset_id = ${assetId}
        ORDER BY created_at DESC, id DESC LIMIT 1
      `;
      if (review?.decision === 'APPROVED') return true;
      if (review?.decision === 'REJECTED') return false;
      await new Promise(r => setTimeout(r, 2000));
    }
    return false;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      '\nInspect keyframe above. Type "APPROVE" to authorize Runway video generation (anything else aborts with 0 Runway calls): ',
    );
    if (answer.trim() !== 'APPROVE') {
      return false;
    }
  } finally {
    rl.close();
  }

  await pgClient.begin(async tx => {
    await tx`
      INSERT INTO shot_asset_selections (story_revision_id, shot_id, kind, shot_revision_id, asset_id, film_id, selected_by)
      VALUES (${storyRevisionId}, ${shotId}, 'IMAGE', ${shotRevisionId}, ${assetId}, ${filmId}, 'canary-producer')
      ON CONFLICT (story_revision_id, shot_id, kind) DO UPDATE SET asset_id = ${assetId}
    `;
    await tx`
      INSERT INTO asset_reviews (id, asset_id, film_id, shot_revision_id, actor_id, decision, reason)
      VALUES (${randomUUID()}, ${assetId}, ${filmId}, ${shotRevisionId}, 'canary-producer', 'APPROVED', 'Interactive canary producer approval')
    `;
  });

  return true;
}

async function main(): Promise<void> {
  assertAttestation();
  const waitUiMode = process.argv.includes('--wait-ui');

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  await migrateDatabase(process.env.DATABASE_URL);

  const filmId = randomUUID();
  const storyRevisionId = randomUUID();
  const sceneId = randomUUID();
  const shotId = randomUUID();
  const shotRevisionId = randomUUID();
  const validationRunId = randomUUID();
  const geminiRateId = randomUUID();
  const runwayRateId = randomUUID();
  const budget = '5000000'; // $5.00 safety cap

  await pgClient.begin(async tx => {
    await tx`INSERT INTO films(id, title, brief, budget_limit_usd_micros, operator_id, idempotency_key, request_hash)
      VALUES(${filmId}, 'Canary PD-05b Film', 'Cinematic neon cafe rain', ${budget}, 'local-operator', ${randomUUID()}, 'canary')`;
    await tx`INSERT INTO film_budget_accounts(film_id, operator_id, budget_limit_usd_micros)
      VALUES(${filmId}, 'local-operator', ${budget})`;
    await tx`INSERT INTO budget_limit_events(id, film_id, actor_id, prior_limit_usd_micros, new_limit_usd_micros, reason)
      VALUES(${randomUUID()}, ${filmId}, 'local-operator', ${budget}, ${budget}, 'canary baseline')`;

    const storyContent = canonicalStoryV2();
    const shotSpec = storyContent.scenes[0].shots[0].spec;
    await tx`INSERT INTO story_revisions(id, film_id, revision_no, state, content, content_hash)
      VALUES(${storyRevisionId}, ${filmId}, 1, 'APPROVED', ${JSON.stringify({ content: storyContent })}::jsonb, 'canary-story-hash')`;
    await tx`UPDATE films SET active_story_revision_id=${storyRevisionId}, status='PLANNING' WHERE id=${filmId}`;
    await tx`INSERT INTO story_validations(id, story_revision_id, context, dependency_hash, rule_set_version, findings)
      VALUES(${validationRunId}, ${storyRevisionId}, 'STORY_APPROVAL', 'canary-dep', 'story-approval-2', '[]'::jsonb)`;
    await tx`INSERT INTO story_approvals(id, story_revision_id, evidence)
      VALUES(${randomUUID()}, ${storyRevisionId}, ${JSON.stringify({
        storyRevisionId,
        contentHash: 'canary-story-hash',
        dependencyHash: 'canary-dep',
        ruleSetVersion: 'story-approval-2',
        validationRunId,
        waiverIds: [],
        waiverSetHash: 'canary-waivers',
        actorId: 'local-operator',
        approvedAt: new Date().toISOString(),
        decision: 'APPROVED',
      })}::jsonb)`;

    await tx`INSERT INTO scenes(id, film_id) VALUES(${sceneId}, ${filmId})`;
    await tx`INSERT INTO story_revision_scenes(film_id, story_revision_id, scene_id, position)
      VALUES(${filmId}, ${storyRevisionId}, ${sceneId}, 1)`;
    await tx`INSERT INTO shots(id, film_id) VALUES(${shotId}, ${filmId})`;
    await tx`INSERT INTO shot_revisions(id, film_id, shot_id, spec, dependency_hash, policy)
      VALUES(${shotRevisionId}, ${filmId}, ${shotId}, ${JSON.stringify(shotSpec)}::jsonb, 'canary-dep-1', '{"effectiveRequirement":"REQUIRED"}'::jsonb)`;
    await tx`INSERT INTO story_revision_shots(film_id, story_revision_id, scene_id, shot_id, shot_revision_id, position)
      VALUES(${filmId}, ${storyRevisionId}, ${sceneId}, ${shotId}, ${shotRevisionId}, 1)`;

    await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
      VALUES(${geminiRateId}, 'GEMINI', 'gemini-3.1-flash-image', 'IMAGE', 'FIXED_PER_REQUEST', 67000, '2026-01-01', '2030-01-01', 'LIVE_VERIFIED canary operator attested')`;
    await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
      VALUES(${runwayRateId}, 'RUNWAY', 'gen4_turbo', 'VIDEO', 'PER_SECOND', 50000, '2026-01-01', '2030-01-01', 'LIVE_VERIFIED canary operator attested')`;
  });

  // ── PD-AT-01b: Gemini Image Canary ─────────────────────────────────────
  const geminiPreview = await previewGeneration(filmId, 'local-operator', {
    storyRevisionId,
    shotRevisionId,
    kind: 'IMAGE',
    rateCardSnapshotId: geminiRateId,
    pricingUnits: 1,
    executionMode: 'LIVE',
  });
  const geminiAdmitted = await admitAttempt(filmId, 'local-operator', randomUUID(), {
    storyRevisionId,
    shotRevisionId,
    kind: 'IMAGE',
    rateCardSnapshotId: geminiRateId,
    pricingUnits: 1,
    executionMode: 'LIVE',
    expectedPreviewHash: geminiPreview.previewHash,
  });
  const geminiOutcome = await completeLiveAttempt(geminiAdmitted.attemptId);
  if (geminiOutcome.outcome !== 'SETTLED' || geminiOutcome.state !== 'SUCCEEDED' || !geminiOutcome.assetId) {
    throw new Error(`PD-AT-01b canary failed: ${JSON.stringify(geminiOutcome)}`);
  }

  const [kfAsset] = await pgClient<{ id: string; storage_path: string; sha256_hash: string }[]>`
    SELECT id, storage_path, sha256_hash FROM assets WHERE id = ${geminiOutcome.assetId}
  `;

  // Assert Runway admission fails BEFORE producer review
  let unapprovedBlocked = false;
  try {
    await previewGeneration(filmId, 'local-operator', {
      storyRevisionId,
      shotRevisionId,
      kind: 'VIDEO',
      rateCardSnapshotId: runwayRateId,
      pricingUnits: 5,
      executionMode: 'LIVE',
    });
  } catch {
    unapprovedBlocked = true;
  }
  if (!unapprovedBlocked) {
    throw new Error('INVARIANT_VIOLATION: Runway preview succeeded before keyframe approval');
  }

  // Producer interactive approval gate
  const approved = await waitForProducerApproval(
    filmId,
    kfAsset.id,
    shotRevisionId,
    shotId,
    storyRevisionId,
    kfAsset.storage_path,
    kfAsset.sha256_hash,
    waitUiMode,
  );
  if (!approved) {
    console.log(JSON.stringify({
      canaryStatus: 'ABORTED_AT_PRODUCER_GATE',
      runwaySubmits: 0,
      gemini: { attemptId: geminiAdmitted.attemptId, sha256: kfAsset.sha256_hash },
    }, null, 2));
    return;
  }

  // ── PD-AT-02b: Runway Video Canary ─────────────────────────────────────
  const runwayPreview = await previewGeneration(filmId, 'local-operator', {
    storyRevisionId,
    shotRevisionId,
    kind: 'VIDEO',
    rateCardSnapshotId: runwayRateId,
    pricingUnits: 5,
    executionMode: 'LIVE',
  });
  const runwayAdmitted = await admitAttempt(filmId, 'local-operator', randomUUID(), {
    storyRevisionId,
    shotRevisionId,
    kind: 'VIDEO',
    rateCardSnapshotId: runwayRateId,
    pricingUnits: 5,
    executionMode: 'LIVE',
    expectedPreviewHash: runwayPreview.previewHash,
  });
  const runwayOutcome = await completeLiveAttempt(runwayAdmitted.attemptId);
  if (runwayOutcome.outcome !== 'SETTLED' || runwayOutcome.state !== 'SUCCEEDED' || !runwayOutcome.assetId) {
    throw new Error(`PD-AT-02b canary failed: ${JSON.stringify(runwayOutcome)}`);
  }

  const [vidAsset] = await pgClient<{ id: string; sha256_hash: string }[]>`
    SELECT id, sha256_hash FROM assets WHERE id = ${runwayOutcome.assetId}
  `;
  const audit = await auditFinancialProjection(filmId);

  console.log(JSON.stringify({
    canaryStatus: 'COMPLETED',
    filmId,
    auditMatches: audit.matches,
    pdAt01b: {
      attemptId: geminiAdmitted.attemptId,
      provider: 'GEMINI',
      model: 'gemini-3.1-flash-image',
      sha256: kfAsset.sha256_hash,
      billingStatus: geminiOutcome.billingStatus,
    },
    pdAt02b: {
      attemptId: runwayAdmitted.attemptId,
      provider: 'RUNWAY',
      model: 'gen4_turbo',
      sha256: vidAsset.sha256_hash,
      billingStatus: runwayOutcome.billingStatus,
    },
  }, null, 2));
}

void main()
  .catch(err => {
    console.error('[canary] Failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgClient.end();
  });

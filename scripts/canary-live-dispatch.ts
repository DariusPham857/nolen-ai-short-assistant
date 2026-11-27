import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { canonicalStoryV2 } from '@nolen/contracts';
import { pgClient } from '../servers/src/db/index.js';
import { migrateDatabase } from '../servers/src/db/migrate.js';
import { completeLiveAttempt } from '../servers/src/dispatch/live-completion.js';
import {
  assertPositiveMicros,
  assertRunwayDuration,
  planCanaryFromExplicitRates,
  planCanaryFromRateRows,
  type CanaryRateSnapshotRow,
  type PlannedCanaryRates,
} from '../servers/src/dispatch/canary-preflight.js';
import {
  admitAttempt,
  auditFinancialProjection,
  previewGeneration,
  readAttemptFinancial,
  readBudget,
} from '../servers/src/financial/repository.js';

function readArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const found = process.argv.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : undefined;
}

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

async function resolveCanaryRates(): Promise<PlannedCanaryRates> {
  const maxBudgetMicros = assertPositiveMicros(
    readArg('max-budget-micros') ?? process.env.CANARY_MAX_BUDGET_MICROS ?? '1000000',
    'max-budget-micros',
  );
  const runwayDurationRaw = readArg('runway-duration') ?? process.env.CANARY_RUNWAY_DURATION_SEC ?? '5';
  const runwayDurationSec = assertRunwayDuration(runwayDurationRaw);

  const existingGeminiRateId = readArg('gemini-rate-id') ?? process.env.CANARY_GEMINI_RATE_ID;
  const existingRunwayRateId = readArg('runway-rate-id') ?? process.env.CANARY_RUNWAY_RATE_ID;

  if (existingGeminiRateId && existingRunwayRateId) {
    const [gem] = await pgClient<CanaryRateSnapshotRow[]>`
      SELECT id, provider, model, operation, rate_type, unit_price_usd_micros,
             provider_maximum_usd_micros, effective_at, expires_at, source_ref
      FROM rate_card_snapshots WHERE id = ${existingGeminiRateId}
    `;
    const [rw] = await pgClient<CanaryRateSnapshotRow[]>`
      SELECT id, provider, model, operation, rate_type, unit_price_usd_micros,
             provider_maximum_usd_micros, effective_at, expires_at, source_ref
      FROM rate_card_snapshots WHERE id = ${existingRunwayRateId}
    `;

    return planCanaryFromRateRows({
      geminiRow: gem,
      runwayRow: rw,
      geminiRateId: existingGeminiRateId,
      runwayRateId: existingRunwayRateId,
      runwayDurationSec,
      maxBudgetMicros,
    });
  }

  return planCanaryFromExplicitRates({
    geminiRateId: randomUUID(),
    runwayRateId: randomUUID(),
    geminiModel: readArg('gemini-model') ?? process.env.CANARY_GEMINI_MODEL ?? '',
    geminiUnitMicros: readArg('gemini-rate-micros') ?? process.env.CANARY_GEMINI_RESERVATION_MICROS ?? '',
    geminiMaxMicros: readArg('gemini-max-micros') ?? process.env.CANARY_GEMINI_MAX_MICROS,
    runwayModel: readArg('runway-model') ?? process.env.CANARY_RUNWAY_MODEL ?? 'gen4_turbo',
    runwayUnitMicros: readArg('runway-rate-micros') ?? process.env.CANARY_RUNWAY_RATE_MICROS ?? '',
    runwayMaxMicros: readArg('runway-max-micros') ?? process.env.CANARY_RUNWAY_MAX_MICROS,
    runwayDurationSec,
    maxBudgetMicros,
    sourceRef: readArg('rate-source-ref') ?? process.env.CANARY_RATE_EVIDENCE_REF ?? '',
  });
}

async function confirmSpendIfNeeded(rates: PlannedCanaryRates): Promise<boolean> {
  console.log('\n[canary] Pre-flight Spend & Reservation Plan (0 automatic retries):');
  console.log(JSON.stringify({
    maxBudgetUsdMicros: rates.maxBudgetMicros,
    totalPlannedReservationUsdMicros: rates.totalReservationMicros,
    gemini: {
      model: rates.geminiModel,
      unitPriceUsdMicros: rates.geminiUnitMicros,
      providerMaximumUsdMicros: rates.geminiProviderMaxMicros,
      reservationUsdMicros: rates.geminiReservationMicros,
    },
    runway: {
      model: rates.runwayModel,
      durationSeconds: rates.runwayDurationSec,
      unitPriceUsdMicrosPerSec: rates.runwayUnitMicros,
      providerMaximumUsdMicros: rates.runwayProviderMaxMicros,
      reservationUsdMicros: rates.runwayReservationMicros,
    },
    rateSourceRef: rates.sourceRef,
  }, null, 2));

  if (process.argv.includes('--confirm-spend')) {
    return true;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('\nType "RUN" to execute PD-AT-01b (Gemini IMAGE) canary: ');
    return answer.trim() === 'RUN';
  } finally {
    rl.close();
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
  const preflightCheckOnly = !readArg('gemini-rate-id') && !process.env.CANARY_GEMINI_RATE_ID;
  if (preflightCheckOnly) {
    // Validate explicit CLI/env rates before connecting to DB so missing args fail fast
    await resolveCanaryRates();
  }
  await migrateDatabase(process.env.DATABASE_URL);

  const rates = await resolveCanaryRates();
  const confirmed = await confirmSpendIfNeeded(rates);
  if (!confirmed) {
    console.log('[canary] Aborted before any API calls.');
    return;
  }

  const filmId = randomUUID();
  const storyRevisionId = randomUUID();
  const sceneId = randomUUID();
  const shotId = randomUUID();
  const shotRevisionId = randomUUID();
  const validationRunId = randomUUID();

  await pgClient.begin(async tx => {
    await tx`INSERT INTO films(id, title, brief, budget_limit_usd_micros, operator_id, idempotency_key, request_hash)
      VALUES(${filmId}, 'Canary PD-05b Film', 'Cinematic neon cafe rain', ${rates.maxBudgetMicros}, 'local-operator', ${randomUUID()}, 'canary')`;
    await tx`INSERT INTO film_budget_accounts(film_id, operator_id, budget_limit_usd_micros)
      VALUES(${filmId}, 'local-operator', ${rates.maxBudgetMicros})`;
    await tx`INSERT INTO budget_limit_events(id, film_id, actor_id, prior_limit_usd_micros, new_limit_usd_micros, reason)
      VALUES(${randomUUID()}, ${filmId}, 'local-operator', ${rates.maxBudgetMicros}, ${rates.maxBudgetMicros}, 'canary baseline')`;

    const storyContent = canonicalStoryV2();
    const shotSpec = {
      ...storyContent.scenes[0].shots[0].spec,
      durationSeconds: rates.runwayDurationSec,
    };
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

    if (rates.createSnapshots) {
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, provider_maximum_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${rates.geminiRateId}, 'GEMINI', ${rates.geminiModel}, 'IMAGE', 'FIXED_PER_REQUEST', ${rates.geminiUnitMicros}, ${rates.geminiProviderMaxMicros}, '2026-01-01', '2030-01-01', ${rates.sourceRef})`;
      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, provider_maximum_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${rates.runwayRateId}, 'RUNWAY', ${rates.runwayModel}, 'VIDEO', 'PER_SECOND', ${rates.runwayUnitMicros}, ${rates.runwayProviderMaxMicros}, '2026-01-01', '2030-01-01', ${rates.sourceRef})`;
    }
  });

  // ── PD-AT-01b: Gemini Image Canary (0 retries) ─────────────────────────
  const geminiPreview = await previewGeneration(filmId, 'local-operator', {
    storyRevisionId,
    shotRevisionId,
    kind: 'IMAGE',
    rateCardSnapshotId: rates.geminiRateId,
    pricingUnits: 1,
    executionMode: 'LIVE',
  });
  const geminiAdmitted = await admitAttempt(filmId, 'local-operator', randomUUID(), {
    storyRevisionId,
    shotRevisionId,
    kind: 'IMAGE',
    rateCardSnapshotId: rates.geminiRateId,
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
      rateCardSnapshotId: rates.runwayRateId,
      pricingUnits: rates.runwayDurationSec,
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
    const budgetState = await readBudget(filmId, 'local-operator');
    const geminiFin = await readAttemptFinancial(geminiAdmitted.attemptId, 'local-operator');
    const audit = await auditFinancialProjection(filmId);
    console.log(JSON.stringify({
      canaryStatus: 'ABORTED_AT_PRODUCER_GATE',
      runwaySubmits: 0,
      filmId,
      budget: budgetState,
      auditMatches: audit.matches,
      pdAt01b: {
        attemptId: geminiAdmitted.attemptId,
        model: rates.geminiModel,
        sha256: kfAsset.sha256_hash,
        financial: geminiFin,
      },
    }, null, 2));
    return;
  }

  // ── PD-AT-02b: Runway Video Canary (0 retries) ─────────────────────────
  const runwayPreview = await previewGeneration(filmId, 'local-operator', {
    storyRevisionId,
    shotRevisionId,
    kind: 'VIDEO',
    rateCardSnapshotId: rates.runwayRateId,
    pricingUnits: rates.runwayDurationSec,
    executionMode: 'LIVE',
  });
  const runwayAdmitted = await admitAttempt(filmId, 'local-operator', randomUUID(), {
    storyRevisionId,
    shotRevisionId,
    kind: 'VIDEO',
    rateCardSnapshotId: rates.runwayRateId,
    pricingUnits: rates.runwayDurationSec,
    executionMode: 'LIVE',
    expectedPreviewHash: runwayPreview.previewHash,
  });
  const runwayOutcome = await completeLiveAttempt(runwayAdmitted.attemptId);
  if (runwayOutcome.outcome !== 'SETTLED' || runwayOutcome.state !== 'SUCCEEDED' || !runwayOutcome.assetId) {
    throw new Error(`PD-AT-02b canary failed: ${JSON.stringify(runwayOutcome)}`);
  }

  const [vidAsset] = await pgClient<{ id: string; storage_path: string; sha256_hash: string }[]>`
    SELECT id, storage_path, sha256_hash FROM assets WHERE id = ${runwayOutcome.assetId}
  `;
  const budgetState = await readBudget(filmId, 'local-operator');
  const geminiFin = await readAttemptFinancial(geminiAdmitted.attemptId, 'local-operator');
  const runwayFin = await readAttemptFinancial(runwayAdmitted.attemptId, 'local-operator');
  const audit = await auditFinancialProjection(filmId);

  console.log(JSON.stringify({
    canaryStatus: 'COMPLETED',
    filmId,
    budget: budgetState,
    auditMatches: audit.matches,
    pdAt01b: {
      attemptId: geminiAdmitted.attemptId,
      provider: 'GEMINI',
      model: rates.geminiModel,
      storagePath: kfAsset.storage_path,
      sha256: kfAsset.sha256_hash,
      financial: geminiFin,
    },
    pdAt02b: {
      attemptId: runwayAdmitted.attemptId,
      provider: 'RUNWAY',
      model: rates.runwayModel,
      storagePath: vidAsset.storage_path,
      sha256: vidAsset.sha256_hash,
      financial: runwayFin,
    },
    reconciliationNote: 'Verify actual usage on Google AI Studio & Runway dashboard, then POST /api/attempts/:attemptId/reconcile with billingStatus=FINAL and exact realizedChargeUsdMicros.',
  }, null, 2));
}

void main()
  .catch((err: unknown) => {
    const e = err as { message?: string; code?: string; errors?: Array<{ message?: string }> } | undefined;
    const msg =
      (e?.message && e.message.trim()) ||
      e?.errors?.map(x => x.message).filter(Boolean).join('; ') ||
      e?.code ||
      String(err);
    console.error('[canary] Failed:', msg);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgClient.end();
  });

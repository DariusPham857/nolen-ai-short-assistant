import { describe, it, expect } from 'vitest';
import {
  providerKindSchema,
  dispatchStateSchema,
  executionModeSchema,
  provenanceSchema,
  generationRequestSchema,
  submissionResultSchema,
  providerStatusUpdateSchema,
  reconciliationResultSchema,
} from './providers.js';

describe('Provider Dispatch Contracts (PD-01)', () => {
  it('validates provider kinds, execution modes, and dispatch states', () => {
    expect(providerKindSchema.parse('GEMINI')).toBe('GEMINI');
    expect(providerKindSchema.parse('RUNWAY')).toBe('RUNWAY');
    expect(providerKindSchema.parse('FAL_KLING')).toBe('FAL_KLING');
    expect(providerKindSchema.parse('LOCAL_PAN_ZOOM')).toBe('LOCAL_PAN_ZOOM');
    expect(() => providerKindSchema.parse('UNKNOWN')).toThrow();

    expect(executionModeSchema.parse('LIVE')).toBe('LIVE');
    expect(executionModeSchema.parse('REPLAY')).toBe('REPLAY');
    expect(() => executionModeSchema.parse('MOCK')).toThrow();

    expect(provenanceSchema.parse('LIVE_PROVIDER')).toBe('LIVE_PROVIDER');
    expect(provenanceSchema.parse('REPLAY_FIXTURE')).toBe('REPLAY_FIXTURE');
    expect(() => provenanceSchema.parse('UNKNOWN')).toThrow();

    expect(dispatchStateSchema.parse('PENDING')).toBe('PENDING');
    expect(dispatchStateSchema.parse('SUBMITTING')).toBe('SUBMITTING');
    expect(dispatchStateSchema.parse('SUBMISSION_UNCERTAIN')).toBe('SUBMISSION_UNCERTAIN');
    expect(dispatchStateSchema.parse('EXHAUSTED')).toBe('EXHAUSTED');
    expect(() => dispatchStateSchema.parse('INVALID_STATE')).toThrow();
  });

  it('validates GenerationRequest with 9:16 aspect ratio default and executionMode REPLAY default', () => {
    const valid = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      filmId: '22222222-2222-4222-8222-222222222222',
      kind: 'IMAGE',
      provider: 'GEMINI',
      prompt: 'A cinematic establishing shot of a neon coffee shop in rainy Tokyo',
    };

    const parsed = generationRequestSchema.parse(valid);
    expect(parsed.aspectRatio).toBe('9:16');
    expect(parsed.provider).toBe('GEMINI');
    expect(parsed.executionMode).toBe('REPLAY');

    // Explicit LIVE executionMode is accepted
    const liveRequest = generationRequestSchema.parse({ ...valid, executionMode: 'LIVE' });
    expect(liveRequest.executionMode).toBe('LIVE');

    // Empty prompt fails
    expect(() => generationRequestSchema.parse({ ...valid, prompt: '' })).toThrow();
    // Invalid UUID fails
    expect(() => generationRequestSchema.parse({ ...valid, attemptId: 'not-a-uuid' })).toThrow();
  });

  it('validates SubmissionResult with executionMode and provenance', () => {
    const submission = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      providerJobId: 'runway-job-abc-123',
      state: 'SUBMITTED',
      executionMode: 'REPLAY',
      provenance: 'REPLAY_FIXTURE',
      submittedAt: new Date().toISOString(),
      estimatedCompletionSeconds: 30,
    };

    const parsed = submissionResultSchema.parse(submission);
    expect(parsed.providerJobId).toBe('runway-job-abc-123');
    expect(parsed.state).toBe('SUBMITTED');
    expect(parsed.executionMode).toBe('REPLAY');
    expect(parsed.provenance).toBe('REPLAY_FIXTURE');

    // Missing provenance throws
    const { provenance, ...missingProvenance } = submission;
    expect(() => submissionResultSchema.parse(missingProvenance)).toThrow();
  });

  it('validates ProviderStatusUpdate with provenance and ReconciliationResult', () => {
    const update = {
      providerJobId: 'gemini-task-999',
      state: 'SUCCEEDED',
      provenance: 'REPLAY_FIXTURE',
      locator: {
        kind: 'REPLAY_FIXTURE',
        packVersion: 'v1',
        fixtureId: 'default-gemini-image-9-16',
      },
    };
    expect(providerStatusUpdateSchema.parse(update).state).toBe('SUCCEEDED');
    expect(providerStatusUpdateSchema.parse(update).provenance).toBe('REPLAY_FIXTURE');

    // REPLAY_FIXTURE with remote mediaUrl throws (BLOCK 2)
    expect(() => providerStatusUpdateSchema.parse({
      providerJobId: 'gemini-task-999',
      state: 'SUCCEEDED',
      provenance: 'REPLAY_FIXTURE',
      mediaUrl: 'https://storage.googleapis.com/test-bucket/asset.png',
      locator: {
        kind: 'REPLAY_FIXTURE',
        packVersion: 'v1',
        fixtureId: 'default-gemini-image-9-16',
      },
    })).toThrow();

    // Missing provenance throws
    expect(() => providerStatusUpdateSchema.parse({
      providerJobId: 'gemini-task-999',
      state: 'SUCCEEDED',
      locator: {
        kind: 'REPLAY_FIXTURE',
        packVersion: 'v1',
        fixtureId: 'default-gemini-image-9-16',
      },
    })).toThrow();

    const reconcile = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      providerJobId: 'runway-job-abc-123',
      outcome: 'CONFIRMED_FAILED_NO_CHARGE',
      evidence: 'Provider HTTP 404 response: job not found in ledger within TTL',
    };
    const parsedReconcile = reconciliationResultSchema.parse(reconcile);
    expect(parsedReconcile.outcome).toBe('CONFIRMED_FAILED_NO_CHARGE');
  });

  it('validates discriminated asset locator (REPLAY_FIXTURE vs REMOTE_URL) on ProviderStatusUpdate (PD-05a.1)', () => {
    const replayUpdate = {
      providerJobId: 'gemini-task-999',
      state: 'SUCCEEDED',
      provenance: 'REPLAY_FIXTURE',
      locator: {
        kind: 'REPLAY_FIXTURE',
        packVersion: 'v1',
        fixtureId: 'gemini-keyframe-01',
      },
    };
    const parsed = providerStatusUpdateSchema.parse(replayUpdate);
    expect(parsed.locator).toBeDefined();
    expect(parsed.locator?.kind).toBe('REPLAY_FIXTURE');

    const remoteUpdate = {
      providerJobId: 'runway-job-abc-123',
      state: 'SUCCEEDED',
      provenance: 'LIVE_PROVIDER',
      locator: {
        kind: 'REMOTE_URL',
        url: 'https://cdn.provider.com/video.mp4',
      },
    };
    const parsedRemote = providerStatusUpdateSchema.parse(remoteUpdate);
    expect(parsedRemote.locator?.kind).toBe('REMOTE_URL');

    // Cross-pair negative assertions (BLOCK 3 / mode boundary containment):
    // 1. REPLAY_FIXTURE with REMOTE_URL locator must fail closed to prevent SSRF and network leakage in REPLAY
    expect(() => providerStatusUpdateSchema.parse({
      providerJobId: 'gemini-task-999',
      state: 'SUCCEEDED',
      provenance: 'REPLAY_FIXTURE',
      locator: {
        kind: 'REMOTE_URL',
        url: 'https://cdn.example.com/asset.mp4',
      },
    })).toThrow();

    // 2. LIVE_PROVIDER with REPLAY_FIXTURE locator must fail closed to prevent fake local fixture usage in LIVE
    expect(() => providerStatusUpdateSchema.parse({
      providerJobId: 'runway-job-abc-123',
      state: 'SUCCEEDED',
      provenance: 'LIVE_PROVIDER',
      locator: {
        kind: 'REPLAY_FIXTURE',
        packVersion: 'v1',
        fixtureId: 'gemini-keyframe-01',
      },
    })).toThrow();

    // Invalid locator kind or structure fails
    expect(() => providerStatusUpdateSchema.parse({
      ...replayUpdate,
      locator: { kind: 'INVALID_LOCATOR_KIND' },
    })).toThrow();
  });

  it('validates GenerationRequest with frozen fixture identity and 64-char hex requestFingerprint (PD-05a.1)', () => {
    const replayReq = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      filmId: '22222222-2222-4222-8222-222222222222',
      kind: 'IMAGE',
      provider: 'GEMINI',
      executionMode: 'REPLAY',
      fixturePackVersion: 'v1',
      fixtureId: 'gemini-kf-01',
      requestFingerprint: 'a'.repeat(64),
      prompt: 'A cinematic establishing shot of a neon coffee shop in rainy Tokyo',
    };
    const parsed = generationRequestSchema.parse(replayReq);
    expect(parsed.fixturePackVersion).toBe('v1');
    expect(parsed.fixtureId).toBe('gemini-kf-01');
    expect(parsed.requestFingerprint).toBe('a'.repeat(64));

    // Invalid fingerprint (not 64-char hex) fails
    expect(() => generationRequestSchema.parse({
      ...replayReq,
      requestFingerprint: 'not-valid-hex-64',
    })).toThrow();
    expect(() => generationRequestSchema.parse({
      ...replayReq,
      requestFingerprint: 'A'.repeat(64), // uppercase rejected
    })).toThrow();
    expect(() => generationRequestSchema.parse({
      ...replayReq,
      requestFingerprint: 'a'.repeat(63), // length 63 rejected
    })).toThrow();

    // BLOCK 2: Strictly rejects directory traversal in fixturePackVersion
    expect(() => generationRequestSchema.parse({
      ...replayReq,
      fixturePackVersion: 'x/../replay-pack-v1',
    })).toThrow(/fixturePackVersion/i);

    expect(() => generationRequestSchema.parse({
      ...replayReq,
      fixturePackVersion: '../v1',
    })).toThrow(/fixturePackVersion/i);
  });

  it('validates GenerationRequestV2 invariants while preserving legacy v1 without schemaVersion injection (GI-03)', () => {
    const legacyV1 = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      filmId: '22222222-2222-4222-8222-222222222222',
      kind: 'IMAGE',
      provider: 'GEMINI',
      prompt: 'Legacy v1 prompt',
    };
    const parsedV1 = generationRequestSchema.parse(legacyV1);
    expect('schemaVersion' in parsedV1).toBe(false);

    const baseV2 = {
      schemaVersion: '2' as const,
      attemptId: '11111111-1111-4111-8111-111111111111',
      filmId: '22222222-2222-4222-8222-222222222222',
      storyRevisionId: '33333333-3333-4333-8333-333333333333',
      shotRevisionId: '44444444-4444-4444-8444-444444444444',
      kind: 'VIDEO' as const,
      provider: 'RUNWAY' as const,
      modelId: 'gen4_turbo',
      rateCardSnapshotId: '55555555-5555-4555-8555-555555555555',
      executionMode: 'REPLAY' as const,
      prompt: 'Hero steps forward slowly',
      negativePrompt: 'blur',
      promptCompilerVersion: 'generation-intent-1' as const,
      shotDependencyHash: 'c'.repeat(64),
      camera: { angle: 'LOW_ANGLE' as const, framing: 'Medium', movement: 'Slow push-in' },
      aspectRatio: '9:16' as const,
      durationSeconds: 5,
      inputAssets: [],
      structuredIntent: {
        shotType: 'CHARACTER' as const,
        authoredPrompt: 'Hero steps forward slowly',
        camera: { angle: 'LOW_ANGLE' as const, framing: 'Medium', movement: 'Slow push-in' },
        location: { id: 'room', name: 'Room', description: 'Quiet studio' },
        styleRef: { id: 'cinema', name: 'Cinema', description: 'Warm light' },
        subjects: [],
        wardrobes: [],
        props: [],
        continuity: { startLighting: 'Warm', endLighting: 'Warm', startCharacters: [], endCharacters: [] },
        intendedTransitions: [],
      },
      fixturePackVersion: 'v1',
      fixtureId: 'default-runway-video-9-16',
    };
    const parsedV2 = generationRequestSchema.parse(baseV2);
    expect('schemaVersion' in parsedV2 && parsedV2.schemaVersion).toBe('2');

    // REPLAY v2 without fixture fails
    const { fixtureId: _f, ...missingFixture } = baseV2;
    expect(() => generationRequestSchema.parse(missingFixture)).toThrow();

    // LIVE v2 with fixture fails
    expect(() => generationRequestSchema.parse({ ...baseV2, executionMode: 'LIVE' })).toThrow();

    // VIDEO > 1000 chars fails
    expect(() => generationRequestSchema.parse({ ...baseV2, prompt: 'x'.repeat(1001) })).toThrow();
  });

  it('validates LOCAL_PIPELINE provenance, LOCAL_STORAGE locator, and START_FRAME lineage (LP-01)', async () => {
    const mod = await import('./providers.js');
    expect(mod.provenanceSchema.parse('LOCAL_PIPELINE')).toBe('LOCAL_PIPELINE');

    const localUpdate = {
      providerJobId: 'local-pz-111',
      state: 'SUCCEEDED',
      provenance: 'LOCAL_PIPELINE',
      locator: {
        kind: 'LOCAL_STORAGE',
        category: 'videos',
        filename: `${'a'.repeat(64)}.mp4`,
        sha256: 'a'.repeat(64),
      },
    };
    expect(mod.providerStatusUpdateSchema.parse(localUpdate).locator?.kind).toBe('LOCAL_STORAGE');

    // Path traversal filename rejected
    expect(() => mod.providerStatusUpdateSchema.parse({
      ...localUpdate,
      locator: { kind: 'LOCAL_STORAGE', category: 'videos', filename: '../evil.mp4', sha256: 'a'.repeat(64) },
    })).toThrow();

    // Remote mediaUrl forbidden with LOCAL_PIPELINE
    expect(() => mod.providerStatusUpdateSchema.parse({
      ...localUpdate,
      mediaUrl: 'https://example.com/v.mp4',
    })).toThrow();

    // Metadata schema enforces upstream startFrameProvenance
    const metaSchema = (mod as Record<string, unknown>).localVideoMetadataSchema as { parse: (v: unknown) => unknown } | undefined;
    expect(metaSchema).toBeDefined();
    expect(() => metaSchema!.parse({
      provenance: 'LOCAL_PIPELINE',
      executionMode: 'LIVE',
      provider: 'LOCAL_PAN_ZOOM',
      cameraMovement: 'Slow push-in',
      durationSeconds: 5,
      startFrameAssetId: '11111111-1111-4111-8111-111111111111',
      startFrameSha256: 'b'.repeat(64),
      startFrameProvenance: 'REPLAY_FIXTURE',
    })).not.toThrow();
    expect(() => metaSchema!.parse({
      provenance: 'LOCAL_PIPELINE',
      executionMode: 'LIVE',
      provider: 'LOCAL_PAN_ZOOM',
      cameraMovement: 'Slow push-in',
      durationSeconds: 5,
      startFrameAssetId: '11111111-1111-4111-8111-111111111111',
      startFrameSha256: 'b'.repeat(64),
      startFrameProvenance: 'LOCAL_PIPELINE',
    })).toThrow();
  });
});

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
      mediaUrl: 'https://storage.googleapis.com/test-bucket/asset.png',
    };
    expect(providerStatusUpdateSchema.parse(update).state).toBe('SUCCEEDED');
    expect(providerStatusUpdateSchema.parse(update).provenance).toBe('REPLAY_FIXTURE');

    // Missing provenance throws
    expect(() => providerStatusUpdateSchema.parse({
      providerJobId: 'gemini-task-999',
      state: 'SUCCEEDED',
      mediaUrl: 'https://storage.googleapis.com/test-bucket/asset.png',
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
});

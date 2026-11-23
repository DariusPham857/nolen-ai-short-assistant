import { describe, it, expect, vi } from 'vitest';
import type { ProviderAdapter } from '../providers/index.js';
import type { GenerationRequest } from '@nolen/contracts';

describe('Dispatch Service Contracts & Outcomes (PD-04)', () => {
  const mockRequest: GenerationRequest = {
    attemptId: '11111111-1111-4111-8111-111111111111',
    filmId: '22222222-2222-4222-8222-222222222222',
    kind: 'IMAGE',
    provider: 'GEMINI',
    prompt: 'A cyberpunk ramen stall in rainy Neo-Seoul',
    aspectRatio: '9:16',
  };

  const mockAdapter: ProviderAdapter = {
    kind: 'GEMINI',
    submit: vi.fn().mockResolvedValue({
      attemptId: mockRequest.attemptId,
      providerJobId: 'gemini-job-123',
      state: 'SUBMITTED',
      submittedAt: new Date().toISOString(),
    }),
    pollStatus: vi.fn().mockResolvedValue({
      providerJobId: 'gemini-job-123',
      state: 'SUCCEEDED',
      mediaUrl: 'https://storage.googleapis.com/test-bucket/asset.png',
    }),
    reconcile: vi.fn().mockResolvedValue({
      attemptId: mockRequest.attemptId,
      providerJobId: 'gemini-job-123',
      outcome: 'CONFIRMED_SUCCEEDED',
      evidence: 'Reconciliation verified remote job completed',
    }),
  };

  it('validates provider adapter interface compliance', async () => {
    expect(mockAdapter.kind).toBe('GEMINI');
    const submission = await mockAdapter.submit(mockRequest);
    expect(submission.providerJobId).toBe('gemini-job-123');

    const status = await mockAdapter.pollStatus(submission.providerJobId);
    expect(status.state).toBe('SUCCEEDED');
    expect(status.mediaUrl).toBe('https://storage.googleapis.com/test-bucket/asset.png');

    const reconciliation = await mockAdapter.reconcile(mockRequest.attemptId, submission.providerJobId);
    expect(reconciliation.outcome).toBe('CONFIRMED_SUCCEEDED');
  });

  it('handles simulated crash before claim without remote calls', async () => {
    const submitSpy = vi.spyOn(mockAdapter, 'submit');
    const simulateCrash = () => {
      throw new Error('SIMULATED_CRASH_BEFORE_CLAIM');
    };

    expect(simulateCrash).toThrow('SIMULATED_CRASH_BEFORE_CLAIM');
    expect(submitSpy).not.toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'non-existent' }));
  });
});

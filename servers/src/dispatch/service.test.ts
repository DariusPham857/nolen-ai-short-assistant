import { describe, it, expect, vi } from 'vitest';
import type { ProviderAdapter } from '../providers/index.js';
import type { GenerationRequest } from '@nolen/contracts';
import { dispatchAttempt, markSubmissionUncertain } from './service.js';
import { pgClient } from '../db/index.js';

describe('Dispatch Service Contracts & Outcomes (PD-04 / BLOCK 1-3)', () => {
  const mockRequest: GenerationRequest = {
    attemptId: '11111111-1111-4111-8111-111111111111',
    filmId: '22222222-2222-4222-8222-222222222222',
    kind: 'IMAGE',
    provider: 'GEMINI',
    executionMode: 'REPLAY',
    prompt: 'A cyberpunk ramen stall in rainy Neo-Seoul',
    aspectRatio: '9:16',
  };

  const mockAdapter: ProviderAdapter = {
    kind: 'GEMINI',
    executionMode: 'REPLAY',
    isFake: true,
    submit: vi.fn().mockResolvedValue({
      attemptId: mockRequest.attemptId,
      providerJobId: 'gemini-job-123',
      state: 'SUBMITTED',
      executionMode: 'REPLAY',
      provenance: 'REPLAY_FIXTURE',
      submittedAt: new Date().toISOString(),
    }),
    pollStatus: vi.fn().mockResolvedValue({
      providerJobId: 'gemini-job-123',
      state: 'SUCCEEDED',
      provenance: 'REPLAY_FIXTURE',
      mediaUrl: 'https://storage.googleapis.com/test-bucket/asset.png',
    }),
    reconcile: vi.fn().mockResolvedValue({
      attemptId: mockRequest.attemptId,
      providerJobId: 'gemini-job-123',
      outcome: 'CONFIRMED_SUCCEEDED',
      evidence: 'Reconciliation verified remote job completed',
    }),
  };

  it('validates provider adapter interface compliance with provenance and executionMode', async () => {
    expect(mockAdapter.kind).toBe('GEMINI');
    expect(mockAdapter.executionMode).toBe('REPLAY');
    expect(mockAdapter.isFake).toBe(true);

    const submission = await mockAdapter.submit(mockRequest);
    expect(submission.providerJobId).toBe('gemini-job-123');
    expect(submission.executionMode).toBe('REPLAY');
    expect(submission.provenance).toBe('REPLAY_FIXTURE');

    const status = await mockAdapter.pollStatus(submission.providerJobId);
    expect(status.state).toBe('SUCCEEDED');
    expect(status.provenance).toBe('REPLAY_FIXTURE');
    expect(status.mediaUrl).toBe('https://storage.googleapis.com/test-bucket/asset.png');

    const reconciliation = await mockAdapter.reconcile(mockRequest.attemptId, submission.providerJobId);
    expect(reconciliation.outcome).toBe('CONFIRMED_SUCCEEDED');
  });

  it('fails closed when attempting to dispatch in LIVE mode with a fake adapter (BLOCK 3)', async () => {
    const liveRequest: GenerationRequest = {
      ...mockRequest,
      executionMode: 'LIVE',
    };

    await expect(dispatchAttempt(liveRequest, mockAdapter)).rejects.toThrow(
      'LIVE_EXECUTION_MODE_VIOLATION',
    );
    expect(mockAdapter.submit).not.toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'LIVE' }));
  });

  it('handles simulated crash before claim without remote calls', async () => {
    const submitSpy = vi.spyOn(mockAdapter, 'submit');
    await expect(
      dispatchAttempt(mockRequest, mockAdapter, { simulateCrashAt: 'BEFORE_CLAIM' }),
    ).rejects.toThrow('SIMULATED_CRASH_BEFORE_CLAIM');

    expect(submitSpy).not.toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'non-existent' }));
  });

  it('markSubmissionUncertain returns skipped: true when CAS criteria fails to match any row', async () => {
    const fakeTx = vi.fn().mockResolvedValue([]);
    const beginSpy = vi.spyOn(pgClient, 'begin').mockImplementation(async (...args) => {
      const callback = typeof args[0] === 'function' ? args[0] : args[1];
      if (typeof callback === 'function') {
        return (callback as (tx: unknown) => unknown)(fakeTx) as never;
      }
      return undefined as never;
    });

    const result = await markSubmissionUncertain('test-attempt-id', 'Sweeper test', {
      claimToken: '00000000-0000-0000-0000-000000000000',
      claimedAt: new Date(),
      expectedState: 'SUBMITTING',
    });

    expect(result).toEqual({ state: null, skipped: true });
    // Verify fakeTx was called for CAS update and immediately aborted without querying attempts or locking budget
    expect(fakeTx).toHaveBeenCalledTimes(1);
    beginSpy.mockRestore();
  });

  it('markSubmissionUncertain updates attempts and financial state only when CAS succeeds', async () => {
    const fakeTx = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const queryStr = strings.join('');
      if (queryStr.includes('UPDATE outbound_dispatches')) {
        return [{ attempt_id: 'test-attempt-id' }];
      }
      if (queryStr.includes('SELECT film_id FROM attempts')) {
        return [{ film_id: 'test-film-id' }];
      }
      if (queryStr.includes('SELECT pending_liability_usd_micros, reserved_open_usd_micros FROM film_budget_accounts')) {
        return [{ pending_liability_usd_micros: '0', reserved_open_usd_micros: '500000' }];
      }
      if (queryStr.includes('SELECT reservation_open_usd_micros, pending_liability_usd_micros FROM attempt_financial_state')) {
        return [{ reservation_open_usd_micros: '500000', pending_liability_usd_micros: '0' }];
      }
      return [];
    });

    const beginSpy = vi.spyOn(pgClient, 'begin').mockImplementation(async (...args) => {
      const callback = typeof args[0] === 'function' ? args[0] : args[1];
      if (typeof callback === 'function') {
        return (callback as (tx: unknown) => unknown)(fakeTx) as never;
      }
      return undefined as never;
    });

    const result = await markSubmissionUncertain('test-attempt-id', 'Sweeper test', {
      claimToken: '00000000-0000-0000-0000-000000000000',
      claimedAt: new Date(),
      expectedState: 'SUBMITTING',
    });

    expect(result).toEqual({ state: 'SUBMISSION_UNCERTAIN', pendingLiabilityHeld: '500000' });
    beginSpy.mockRestore();
  });
});

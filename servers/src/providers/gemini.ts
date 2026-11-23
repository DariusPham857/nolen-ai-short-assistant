import type {
  GenerationRequest,
  SubmissionResult,
  ProviderStatusUpdate,
  ReconciliationResult,
} from '@nolen/contracts';
import type { ProviderAdapter } from './adapter.js';

export class FakeGeminiAdapter implements ProviderAdapter {
  readonly kind = 'GEMINI' as const;

  async submit(request: GenerationRequest): Promise<SubmissionResult> {
    if (request.kind !== 'IMAGE') {
      throw new Error(`Gemini adapter only supports IMAGE generation, received ${request.kind}`);
    }

    const providerJobId = `gemini-${request.attemptId}`;
    return {
      attemptId: request.attemptId,
      providerJobId,
      state: 'SUBMITTED',
      submittedAt: new Date().toISOString(),
      estimatedCompletionSeconds: 5,
    };
  }

  async pollStatus(providerJobId: string): Promise<ProviderStatusUpdate> {
    return {
      providerJobId,
      state: 'SUCCEEDED',
      mediaUrl: 'https://storage.googleapis.com/nolen-fixtures/gemini-mock-keyframe.png',
      rawResponse: { model: 'gemini-3.1-flash-image', seed: 42 },
    };
  }

  async reconcile(attemptId: string, providerJobId: string | null): Promise<ReconciliationResult> {
    if (providerJobId) {
      return {
        attemptId,
        providerJobId,
        outcome: 'CONFIRMED_SUCCEEDED',
        evidence: `Fake Gemini reconciliation confirmed successful generation for job ${providerJobId}`,
      };
    }
    return {
      attemptId,
      providerJobId: null,
      outcome: 'CONFIRMED_FAILED_NO_CHARGE',
      evidence: 'Fake Gemini reconciliation confirmed no remote job was created before crash',
    };
  }
}

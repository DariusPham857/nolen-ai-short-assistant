import type {
  GenerationRequest,
  SubmissionResult,
  ProviderStatusUpdate,
  ReconciliationResult,
} from '@nolen/contracts';
import type { ProviderAdapter } from './adapter.js';

export class FakeFalKlingAdapter implements ProviderAdapter {
  readonly kind = 'FAL_KLING' as const;

  async submit(request: GenerationRequest): Promise<SubmissionResult> {
    if (request.kind !== 'VIDEO') {
      throw new Error(`fal.ai Kling adapter only supports VIDEO generation, received ${request.kind}`);
    }

    const providerJobId = `fal-${request.attemptId}`;
    return {
      attemptId: request.attemptId,
      providerJobId,
      state: 'SUBMITTED',
      submittedAt: new Date().toISOString(),
      estimatedCompletionSeconds: 30,
    };
  }

  async pollStatus(providerJobId: string): Promise<ProviderStatusUpdate> {
    return {
      providerJobId,
      state: 'SUCCEEDED',
      mediaUrl: 'https://storage.googleapis.com/nolen-fixtures/fal-kling-mock-video.mp4',
      rawResponse: { endpoint: 'fal-ai/kling-video/v3/pro/image-to-video' },
    };
  }

  async reconcile(attemptId: string, providerJobId: string | null): Promise<ReconciliationResult> {
    if (providerJobId) {
      return {
        attemptId,
        providerJobId,
        outcome: 'CONFIRMED_SUCCEEDED',
        evidence: `fal.ai status check confirmed job ${providerJobId} completed`,
      };
    }
    return {
      attemptId,
      providerJobId: null,
      outcome: 'CONFIRMED_FAILED_NO_CHARGE',
      evidence: 'fal.ai request ID not recorded in provider queue; safe no-charge release',
    };
  }
}

import type {
  GenerationRequest,
  SubmissionResult,
  ProviderStatusUpdate,
  ReconciliationResult,
} from '@nolen/contracts';
import type { ProviderAdapter } from './adapter.js';

export class LocalPanZoomAdapter implements ProviderAdapter {
  readonly kind = 'LOCAL_PAN_ZOOM' as const;
  readonly executionMode = 'REPLAY' as const;
  readonly isFake = true as const;

  async submit(request: GenerationRequest): Promise<SubmissionResult> {
    if (request.executionMode === 'LIVE') {
      throw new Error('LIVE_LOCAL_PAN_ZOOM_UNAVAILABLE: Live FFmpeg execution is not yet configured; use REPLAY mode');
    }
    if (request.kind !== 'VIDEO') {
      throw new Error(`Pan/zoom adapter produces VIDEO, received ${request.kind}`);
    }

    return {
      attemptId: request.attemptId,
      providerJobId: `local-pz-${request.attemptId}`,
      state: 'SUCCEEDED',
      executionMode: 'REPLAY',
      provenance: 'REPLAY_FIXTURE',
      submittedAt: new Date().toISOString(),
      estimatedCompletionSeconds: 2,
    };
  }

  async pollStatus(providerJobId: string): Promise<ProviderStatusUpdate> {
    return {
      providerJobId,
      state: 'SUCCEEDED',
      provenance: 'REPLAY_FIXTURE',
      mediaUrl: 'https://storage.googleapis.com/nolen-fixtures/local-pan-zoom-mock.mp4',
      rawResponse: { filter: 'zoompan', fps: 30 },
    };
  }

  async reconcile(attemptId: string, providerJobId: string | null): Promise<ReconciliationResult> {
    return {
      attemptId,
      providerJobId: providerJobId ?? `local-pz-${attemptId}`,
      outcome: 'CONFIRMED_SUCCEEDED',
      evidence: 'Local pipeline requires zero external network settlement; deterministic local state',
    };
  }
}

import type {
  ExecutionMode,
  GenerationRequest,
  ProviderStatusUpdate,
  ReconciliationResult,
  SubmissionResult,
} from '@nolen/contracts';
import type { StorageAdapter } from '../lib/storage.js';
import type { ProviderAdapter } from './adapter.js';

export interface LocalPanZoomAdapterOptions {
  storage?: StorageAdapter;
}

export class LocalPanZoomAdapter implements ProviderAdapter {
  readonly kind = 'LOCAL_PAN_ZOOM' as const;
  readonly executionMode: ExecutionMode;
  readonly isFake: boolean;

  constructor(mode: ExecutionMode = 'REPLAY', _options?: LocalPanZoomAdapterOptions) {
    this.executionMode = mode;
    this.isFake = mode === 'REPLAY';
  }

  async submit(request: GenerationRequest): Promise<SubmissionResult> {
    if (request.kind !== 'VIDEO') {
      throw new Error(`LOCAL_PAN_ZOOM adapter only supports VIDEO generation, received ${request.kind}`);
    }
    if (this.executionMode === 'REPLAY' && request.executionMode === 'LIVE') {
      throw new Error('LIVE_LOCAL_PAN_ZOOM_UNAVAILABLE: Replay LocalPanZoomAdapter cannot execute LIVE requests');
    }
    if (this.executionMode === 'LIVE' && request.executionMode !== 'LIVE') {
      throw new Error('EXECUTION_MODE_MISMATCH: LIVE LocalPanZoomAdapter requires LIVE executionMode');
    }

    const providerJobId = `local-pan-zoom-${request.attemptId}`;
    return {
      attemptId: request.attemptId,
      providerJobId,
      state: 'SUCCEEDED',
      executionMode: this.executionMode,
      provenance: this.executionMode === 'LIVE' ? 'LOCAL_PIPELINE' : 'REPLAY_FIXTURE',
      submittedAt: new Date().toISOString(),
    };
  }

  async pollStatus(providerJobId: string): Promise<ProviderStatusUpdate> {
    return {
      providerJobId,
      state: 'SUCCEEDED',
      provenance: this.executionMode === 'LIVE' ? 'LOCAL_PIPELINE' : 'REPLAY_FIXTURE',
      locator: {
        kind: 'REPLAY_FIXTURE',
        packVersion: 'v1',
        fixtureId: 'default-local_pan_zoom-video-9-16',
      },
      rawResponse: { model: 'ffmpeg-pan-zoom' },
    };
  }

  async reconcile(attemptId: string, providerJobId: string | null): Promise<ReconciliationResult> {
    if (providerJobId) {
      return {
        attemptId,
        providerJobId,
        outcome: 'CONFIRMED_RUNNING',
        evidence: `LOCAL_PAN_ZOOM reconciliation confirmed job ${providerJobId}`,
      };
    }
    return {
      attemptId,
      providerJobId: null,
      outcome: 'UNRESOLVED_MANUAL_REVIEW',
      evidence: 'LOCAL_PAN_ZOOM submission uncertain without providerJobId',
    };
  }
}

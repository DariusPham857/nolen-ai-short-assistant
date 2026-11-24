import type {
  GenerationRequest,
  SubmissionResult,
  ProviderStatusUpdate,
  ReconciliationResult,
} from '@nolen/contracts';
import type { ProviderAdapter } from './adapter.js';

export class FakeRunwayAdapter implements ProviderAdapter {
  readonly kind = 'RUNWAY' as const;
  readonly executionMode = 'REPLAY' as const;
  readonly isFake = true as const;

  async submit(request: GenerationRequest): Promise<SubmissionResult> {
    if (request.executionMode === 'LIVE') {
      throw new Error('FAKE_TRANSPORT_FORBIDDEN_IN_LIVE: FakeRunwayAdapter cannot execute in LIVE mode');
    }
    if (request.kind !== 'VIDEO') {
      throw new Error(`Runway adapter only supports VIDEO generation, received ${request.kind}`);
    }

    const providerJobId = `runway-task-${request.attemptId}`;
    return {
      attemptId: request.attemptId,
      providerJobId,
      state: 'SUBMITTED',
      executionMode: 'REPLAY',
      provenance: 'REPLAY_FIXTURE',
      submittedAt: new Date().toISOString(),
      estimatedCompletionSeconds: 25,
    };
  }

  async pollStatus(providerJobId: string): Promise<ProviderStatusUpdate> {
    return {
      providerJobId,
      state: 'SUCCEEDED',
      provenance: 'REPLAY_FIXTURE',
      locator: {
        kind: 'REPLAY_FIXTURE',
        packVersion: 'v1',
        fixtureId: 'default-runway-video-9-16',
      },
      rawResponse: { model: 'gen4_turbo', duration: 4 },
    };
  }

  async reconcile(attemptId: string, providerJobId: string | null): Promise<ReconciliationResult> {
    if (providerJobId) {
      return {
        attemptId,
        providerJobId,
        outcome: 'CONFIRMED_RUNNING',
        evidence: `Runway reconciliation confirmed active fixture job ${providerJobId}`,
      };
    }
    return {
      attemptId,
      providerJobId: null,
      outcome: 'UNRESOLVED_MANUAL_REVIEW',
      evidence: 'Runway submission uncertain without durable provider_job_id; operator inspection required',
    };
  }
}

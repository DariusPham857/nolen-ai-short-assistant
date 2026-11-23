import type {
  GenerationRequest,
  SubmissionResult,
  ProviderStatusUpdate,
  ReconciliationResult,
  ProviderKind,
} from '@nolen/contracts';

export interface ProviderAdapter {
  readonly kind: ProviderKind;

  /**
   * Submits a generation request to the provider.
   * Remote calls must be idempotent whenever supported by provider headers.
   */
  submit(request: GenerationRequest): Promise<SubmissionResult>;

  /**
   * Polls the active status of an in-flight provider job.
   */
  pollStatus(providerJobId: string): Promise<ProviderStatusUpdate>;

  /**
   * Reconciles uncertain submission state after crash or timeout.
   */
  reconcile(attemptId: string, providerJobId: string | null): Promise<ReconciliationResult>;
}

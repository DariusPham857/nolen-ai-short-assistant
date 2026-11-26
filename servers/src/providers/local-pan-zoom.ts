import path from 'node:path';
import {
  providerStatusUpdateSchema,
  submissionResultSchema,
  type ExecutionMode,
  type GenerationRequest,
  type ProviderStatusUpdate,
  type ReconciliationResult,
  type SubmissionResult,
} from '@nolen/contracts';
import type { StorageAdapter } from '../lib/storage.js';
import type { ProviderAdapter } from './adapter.js';
import { renderLocalPanZoomMp4, type RenderLocalPanZoomOptions } from './ffmpeg-pan-zoom.js';

export interface LocalStartFrameInfo {
  storagePath: string;
  sha256Hash: string;
}

export interface LocalPanZoomAdapterOptions {
  storage?: StorageAdapter;
  resolveStartFrame?: (
    assetId: string,
    filmId: string,
    shotRevisionId: string | null | undefined,
  ) => Promise<LocalStartFrameInfo>;
  renderOptions?: RenderLocalPanZoomOptions;
}

export class LocalPanZoomAdapter implements ProviderAdapter {
  readonly kind = 'LOCAL_PAN_ZOOM' as const;
  readonly executionMode: ExecutionMode;
  readonly isFake: boolean;
  private readonly options?: LocalPanZoomAdapterOptions;
  private readonly liveResults = new Map<string, { status: ProviderStatusUpdate; sha256Hash: string; storagePath: string }>();

  constructor(mode: ExecutionMode = 'REPLAY', options?: LocalPanZoomAdapterOptions) {
    this.executionMode = mode;
    this.isFake = mode === 'REPLAY';
    this.options = options;
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

    if (this.executionMode === 'REPLAY') {
      return submissionResultSchema.parse({
        attemptId: request.attemptId,
        providerJobId,
        state: 'SUCCEEDED',
        executionMode: 'REPLAY',
        provenance: 'REPLAY_FIXTURE',
        submittedAt: new Date().toISOString(),
      });
    }

    if (!this.options?.storage || !this.options?.resolveStartFrame) {
      throw new Error(
        'LIVE_LOCAL_PAN_ZOOM_DIRECT_SUBMIT_UNSUPPORTED: LIVE LocalPanZoomAdapter requires storage and resolveStartFrame (or use completeLocalPanZoomAttempt)',
      );
    }

    if (!('schemaVersion' in request) || request.schemaVersion !== '2') {
      throw new Error('INVALID_DISPATCH_PAYLOAD: LIVE LOCAL_PAN_ZOOM requires GenerationRequestV2');
    }
    const startFrameInput = request.inputAssets.find(
      a => a.role === 'START_FRAME' && a.source === 'GENERATED_ASSET',
    );
    if (!startFrameInput) {
      throw new Error('START_FRAME_MISSING: LIVE LOCAL_PAN_ZOOM requires a START_FRAME input asset');
    }
    const durationSeconds = request.durationSeconds;
    if (!durationSeconds || !Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) {
      throw new Error(`LOCAL_RENDER_FAILED: Invalid durationSeconds ${durationSeconds}`);
    }

    const startInfo = await this.options.resolveStartFrame(
      startFrameInput.assetId,
      request.filmId,
      request.shotRevisionId,
    );
    const rendered = await renderLocalPanZoomMp4(
      {
        attemptId: request.attemptId,
        storage: this.options.storage,
        startFrameStoragePath: startInfo.storagePath,
        startFrameSha256: startInfo.sha256Hash,
        durationSeconds,
        cameraMovement: request.camera.movement,
      },
      this.options.renderOptions,
    );

    const status = providerStatusUpdateSchema.parse({
      providerJobId,
      state: 'SUCCEEDED',
      provenance: 'LOCAL_PIPELINE',
      locator: {
        kind: 'LOCAL_STORAGE',
        category: 'videos',
        filename: path.basename(rendered.storagePath),
        sha256: rendered.sha256Hash,
      },
      rawResponse: {
        model: 'ffmpeg-pan-zoom',
        durationSeconds: rendered.durationSeconds,
        byteSize: rendered.byteSize,
      },
    });
    this.liveResults.set(providerJobId, {
      status,
      sha256Hash: rendered.sha256Hash,
      storagePath: rendered.storagePath,
    });

    return submissionResultSchema.parse({
      attemptId: request.attemptId,
      providerJobId,
      state: 'SUCCEEDED',
      executionMode: 'LIVE',
      provenance: 'LOCAL_PIPELINE',
      submittedAt: new Date().toISOString(),
    });
  }

  async pollStatus(providerJobId: string): Promise<ProviderStatusUpdate> {
    if (this.executionMode === 'REPLAY') {
      return providerStatusUpdateSchema.parse({
        providerJobId,
        state: 'SUCCEEDED',
        provenance: 'REPLAY_FIXTURE',
        locator: {
          kind: 'REPLAY_FIXTURE',
          packVersion: 'v1',
          fixtureId: 'default-local_pan_zoom-video-9-16',
        },
        rawResponse: { model: 'ffmpeg-pan-zoom' },
      });
    }

    const recorded = this.liveResults.get(providerJobId);
    if (!recorded) {
      throw new Error(`LOCAL_PAN_ZOOM_JOB_NOT_FOUND: No rendered LIVE job recorded for ${providerJobId}`);
    }
    return recorded.status;
  }

  async reconcile(attemptId: string, providerJobId: string | null): Promise<ReconciliationResult> {
    if (this.executionMode === 'REPLAY') {
      if (providerJobId) {
        return {
          attemptId,
          providerJobId,
          outcome: 'CONFIRMED_RUNNING',
          evidence: `LOCAL_PAN_ZOOM REPLAY reconciliation confirmed job ${providerJobId}`,
        };
      }
      return {
        attemptId,
        providerJobId: null,
        outcome: 'UNRESOLVED_MANUAL_REVIEW',
        evidence: 'LOCAL_PAN_ZOOM submission uncertain without providerJobId',
      };
    }

    if (providerJobId) {
      const recorded = this.liveResults.get(providerJobId);
      if (recorded) {
        return {
          attemptId,
          providerJobId,
          outcome: 'CONFIRMED_SUCCEEDED',
          evidence: `LOCAL_PAN_ZOOM LIVE verified ${recorded.storagePath} (${recorded.sha256Hash})`,
        };
      }
    }

    return {
      attemptId,
      providerJobId: providerJobId ?? null,
      outcome: 'UNRESOLVED_MANUAL_REVIEW',
      evidence: 'LIVE LOCAL_PAN_ZOOM job has no recorded local render output',
    };
  }
}

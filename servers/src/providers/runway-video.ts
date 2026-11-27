import type {
  BillingEvidence,
  GenerationRequest,
  ProviderStatusUpdate,
  ReconciliationResult,
  SubmissionResult,
} from '@nolen/contracts';
import type { ProviderAdapter } from './adapter.js';
import type { FetchLike } from './gemini-image.js';
import { StorageAdapter, storage as defaultStorage } from '../lib/storage.js';

export interface LiveRunwayAdapterOptions {
  apiKey?: string;
  storage?: StorageAdapter;
  transportFn?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
  apiVersion?: string;
}

const DEFAULT_RUNWAY_BASE_URL = 'https://api.dev.runwayml.com/v1';
const DEFAULT_RUNWAY_VERSION = '2024-11-06';
const DEFAULT_TIMEOUT_MS = 60_000;

function extractRunwayBillingEvidence(json: unknown, taskId: string): BillingEvidence {
  const obj = json as {
    billing?: {
      realizedChargeUsdMicros?: unknown;
      uncharged?: unknown;
      evidenceRef?: unknown;
    };
  } | null;

  const rawCharge = obj?.billing?.realizedChargeUsdMicros;
  const rawRef = typeof obj?.billing?.evidenceRef === 'string' && obj.billing.evidenceRef.length > 0
    ? obj.billing.evidenceRef
    : `runway:task:${taskId}`;

  if (obj?.billing?.uncharged === true || rawCharge === '0') {
    return {
      status: 'CONFIRMED_UNCHARGED',
      evidenceRef: rawRef,
    };
  }

  if (typeof rawCharge === 'string' && /^\d+$/.test(rawCharge) && BigInt(rawCharge) > 0n) {
    return {
      status: 'CONFIRMED_CHARGED',
      realizedChargeUsdMicros: rawCharge,
      evidenceRef: rawRef,
    };
  }

  return {
    status: 'PENDING',
    evidenceRef: rawRef,
  };
}

/**
 * LIVE Runway Developer API (gen4_turbo) I2V adapter (Pathway B: remote URL + SSRF stream).
 */
export class LiveRunwayVideoAdapter implements ProviderAdapter {
  readonly kind = 'RUNWAY' as const;
  readonly executionMode = 'LIVE' as const;
  readonly isFake = false as const;

  private readonly apiKey: string;
  private readonly storage: StorageAdapter;
  private readonly transport: FetchLike;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly apiVersion: string;

  constructor(options: LiveRunwayAdapterOptions = {}) {
    const key = (options.apiKey ?? process.env.RUNWAY_API_KEY ?? '').trim();
    if (!key) {
      throw new Error('LIVE_PROVIDER_UNAVAILABLE: RUNWAY_API_KEY is not configured');
    }
    this.apiKey = key;
    this.storage = options.storage ?? defaultStorage;
    this.transport = options.transportFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.baseUrl = (options.baseUrl ?? DEFAULT_RUNWAY_BASE_URL).replace(/\/+$/, '');
    this.apiVersion = options.apiVersion ?? DEFAULT_RUNWAY_VERSION;
  }

  private async resolvePromptImage(request: GenerationRequest): Promise<string> {
    if ('schemaVersion' in request && request.schemaVersion === '2') {
      const startFrame = request.inputAssets.find(a => a.role === 'START_FRAME');
      if (!startFrame) {
        throw new Error('RUNWAY_START_FRAME_REQUIRED: VIDEO request requires an approved START_FRAME asset');
      }
      const ext = startFrame.mimeType === 'image/jpeg' ? '.jpg' : '.png';
      const filename = `${startFrame.sha256Hash}${ext}`;
      if (this.storage.exists('keyframes', filename)) {
        const buf = await this.storage.read('keyframes', filename);
        return `data:${startFrame.mimeType};base64,${buf.toString('base64')}`;
      }
      if (this.storage.exists('keyframes', `${startFrame.sha256Hash}.png`)) {
        const buf = await this.storage.read('keyframes', `${startFrame.sha256Hash}.png`);
        return `data:${startFrame.mimeType};base64,${buf.toString('base64')}`;
      }
      throw new Error(`RUNWAY_KEYFRAME_MISSING_ON_DISK: ${startFrame.sha256Hash}`);
    }

    if ('keyframeUrl' in request && request.keyframeUrl) {
      return request.keyframeUrl;
    }

    throw new Error('RUNWAY_START_FRAME_REQUIRED: keyframe reference missing');
  }

  async submit(request: GenerationRequest): Promise<SubmissionResult> {
    if (request.executionMode !== 'LIVE') {
      throw new Error('LIVE_ADAPTER_REQUIRES_LIVE_MODE: LiveRunwayVideoAdapter requires executionMode=LIVE');
    }
    if (request.kind !== 'VIDEO') {
      throw new Error(`Runway video adapter only supports VIDEO generation, received ${request.kind}`);
    }

    const promptImage = await this.resolvePromptImage(request);
    const model = 'modelId' in request && request.modelId ? request.modelId : 'gen4_turbo';
    const duration = request.durationSeconds ?? 5;

    const res = await this.transport(`${this.baseUrl}/image_to_video`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'X-Runway-Version': this.apiVersion,
        'Content-Type': 'application/json',
        'Idempotency-Key': request.attemptId,
      },
      body: JSON.stringify({
        model,
        promptImage,
        promptText: request.prompt,
        ratio: '720:1280',
        duration,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`RUNWAY_HTTP_ERROR: status ${res.status}`);
    }

    const json = (await res.json()) as { id?: string };
    if (!json?.id || typeof json.id !== 'string') {
      throw new Error('RUNWAY_INVALID_SUBMIT_RESPONSE: missing task id');
    }

    return {
      attemptId: request.attemptId,
      providerJobId: json.id,
      state: 'SUBMITTED',
      executionMode: 'LIVE',
      provenance: 'LIVE_PROVIDER',
      submittedAt: new Date().toISOString(),
    };
  }

  async pollStatus(providerJobId: string): Promise<ProviderStatusUpdate> {
    const res = await this.transport(`${this.baseUrl}/tasks/${encodeURIComponent(providerJobId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'X-Runway-Version': this.apiVersion,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      if (res.status === 404) {
        return {
          providerJobId,
          state: 'FAILED',
          provenance: 'LIVE_PROVIDER',
          errorMessage: `RUNWAY_TASK_NOT_FOUND: ${providerJobId}`,
          billingEvidence: { status: 'PENDING', evidenceRef: `runway:404:${providerJobId}` },
        };
      }
      throw new Error(`RUNWAY_POLL_HTTP_ERROR: status ${res.status}`);
    }

    const json = (await res.json()) as {
      id?: string;
      status?: string;
      output?: string[];
      failure?: string;
      failureCode?: string;
      billing?: unknown;
    };

    const rawStatus = (json?.status ?? '').toUpperCase();
    const billingEvidence = extractRunwayBillingEvidence(json, providerJobId);

    if (rawStatus === 'PENDING' || rawStatus === 'THROTTLED' || rawStatus === 'RUNNING') {
      return {
        providerJobId,
        state: 'RUNNING',
        provenance: 'LIVE_PROVIDER',
        rawResponse: json,
      };
    }

    if (rawStatus === 'SUCCEEDED') {
      const mediaUrl = Array.isArray(json.output) ? json.output[0] : undefined;
      if (!mediaUrl || typeof mediaUrl !== 'string') {
        return {
          providerJobId,
          state: 'FAILED',
          provenance: 'LIVE_PROVIDER',
          errorMessage: 'RUNWAY_MISSING_OUTPUT_URL',
          billingEvidence,
          rawResponse: json,
        };
      }
      return {
        providerJobId,
        state: 'SUCCEEDED',
        provenance: 'LIVE_PROVIDER',
        mediaUrl,
        locator: { kind: 'REMOTE_URL', url: mediaUrl },
        billingEvidence,
        rawResponse: json,
      };
    }

    return {
      providerJobId,
      state: 'FAILED',
      provenance: 'LIVE_PROVIDER',
      errorMessage: json?.failure ?? json?.failureCode ?? `RUNWAY_TASK_FAILED: ${rawStatus}`,
      billingEvidence,
      rawResponse: json,
    };
  }

  async reconcile(attemptId: string, providerJobId: string | null): Promise<ReconciliationResult> {
    if (!providerJobId) {
      return {
        attemptId,
        providerJobId: null,
        outcome: 'UNRESOLVED_MANUAL_REVIEW',
        evidence: 'Runway submission uncertain without persisted providerJobId',
      };
    }

    const update = await this.pollStatus(providerJobId);
    if (update.state === 'SUCCEEDED') {
      return {
        attemptId,
        providerJobId,
        outcome: 'CONFIRMED_SUCCEEDED',
        evidence: `Runway task ${providerJobId} confirmed SUCCEEDED`,
      };
    }
    if (update.state === 'RUNNING') {
      return {
        attemptId,
        providerJobId,
        outcome: 'CONFIRMED_RUNNING',
        evidence: `Runway task ${providerJobId} is actively RUNNING`,
      };
    }
    if (update.billingEvidence?.status === 'CONFIRMED_UNCHARGED') {
      return {
        attemptId,
        providerJobId,
        outcome: 'CONFIRMED_FAILED_NO_CHARGE',
        evidence: update.errorMessage ?? `Runway task ${providerJobId} failed without charge`,
      };
    }
    return {
      attemptId,
      providerJobId,
      outcome: 'UNRESOLVED_MANUAL_REVIEW',
      evidence: update.errorMessage ?? `Runway task ${providerJobId} failed with unconfirmed billing`,
    };
  }
}

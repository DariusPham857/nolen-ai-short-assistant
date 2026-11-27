import {
  falQueueResultResponseSchema,
  falQueueStatusResponseSchema,
  falQueueSubmitResponseSchema,
  type BillingEvidence,
  type GenerationRequest,
  type ProviderStatusUpdate,
  type ReconciliationResult,
  type SubmissionResult,
} from '@nolen/contracts';
import type { ProviderAdapter } from './adapter.js';
import type { FetchLike } from './gemini-image.js';
import { StorageAdapter, storage as defaultStorage } from '../lib/storage.js';

export const AUTHORIZED_FAL_API_ORIGINS = new Set([
  'https://queue.fal.run',
  'https://fal.run',
]);

const DEFAULT_FAL_ENDPOINT = 'https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video';
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Exact URL.origin whitelist guard preventing FAL_KEY credential leakage.
 * Hostname suffix checks are explicitly forbidden.
 */
export function assertAuthorizedFalOrigin(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`FAL_UNSAFE_ORIGIN: Invalid URL ${rawUrl}`);
  }
  if (!AUTHORIZED_FAL_API_ORIGINS.has(parsed.origin)) {
    throw new Error(`FAL_UNSAFE_ORIGIN: Origin ${parsed.origin} is not in approved fal API whitelist`);
  }
  return parsed;
}

export function encodeFalProviderJobId(requestId: string, statusUrl: string, responseUrl: string): string {
  return `${requestId}|${statusUrl}|${responseUrl}`;
}

export function parseFalProviderJobId(providerJobId: string): {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
} {
  const parts = providerJobId.split('|');
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    assertAuthorizedFalOrigin(parts[1]);
    assertAuthorizedFalOrigin(parts[2]);
    return { requestId: parts[0], statusUrl: parts[1], responseUrl: parts[2] };
  }
  const requestId = providerJobId;
  const base = `${DEFAULT_FAL_ENDPOINT}/requests/${encodeURIComponent(requestId)}`;
  return {
    requestId,
    statusUrl: `${base}/status`,
    responseUrl: base,
  };
}

function extractFalBillingEvidence(raw: unknown, requestId: string): BillingEvidence {
  const obj = raw as {
    billing?: { realizedChargeUsdMicros?: unknown; uncharged?: unknown; evidenceRef?: unknown };
  } | null;

  const rawCharge = obj?.billing?.realizedChargeUsdMicros;
  const rawRef = typeof obj?.billing?.evidenceRef === 'string' && obj.billing.evidenceRef.length > 0
    ? obj.billing.evidenceRef
    : `fal:request:${requestId}`;

  if (obj?.billing?.uncharged === true || rawCharge === '0') {
    return { status: 'CONFIRMED_UNCHARGED', evidenceRef: rawRef };
  }
  if (typeof rawCharge === 'string' && /^\d+$/.test(rawCharge) && BigInt(rawCharge) > 0n) {
    return { status: 'CONFIRMED_CHARGED', realizedChargeUsdMicros: rawCharge, evidenceRef: rawRef };
  }
  return { status: 'PENDING', evidenceRef: rawRef };
}

export interface LiveFalKlingAdapterOptions {
  apiKey?: string;
  storage?: StorageAdapter;
  transportFn?: FetchLike;
  timeoutMs?: number;
  submitUrl?: string;
}

/**
 * LIVE fal.ai Kling Video Queue adapter (Pathway B: remote URL + SSRF stream).
 * Enforces exact URL.origin whitelist before every authenticated request carrying FAL_KEY.
 */
export class LiveFalKlingVideoAdapter implements ProviderAdapter {
  readonly kind = 'FAL_KLING' as const;
  readonly executionMode = 'LIVE' as const;
  readonly isFake = false as const;

  private readonly apiKey: string;
  private readonly storage: StorageAdapter;
  private readonly transport: FetchLike;
  private readonly timeoutMs: number;
  private readonly submitUrl: string;

  constructor(options: LiveFalKlingAdapterOptions = {}) {
    const key = (options.apiKey ?? process.env.FAL_API_KEY ?? process.env.FAL_KEY ?? '').trim();
    if (!key) {
      throw new Error('LIVE_PROVIDER_UNAVAILABLE: FAL_API_KEY is not configured');
    }
    this.apiKey = key;
    this.storage = options.storage ?? defaultStorage;
    this.transport = options.transportFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const submitUrl = options.submitUrl ?? DEFAULT_FAL_ENDPOINT;
    assertAuthorizedFalOrigin(submitUrl);
    this.submitUrl = submitUrl;
  }

  private async resolveImageUrl(request: GenerationRequest): Promise<string> {
    if ('schemaVersion' in request && request.schemaVersion === '2') {
      const startFrame = request.inputAssets.find(a => a.role === 'START_FRAME');
      if (!startFrame) {
        throw new Error('FAL_START_FRAME_REQUIRED: VIDEO request requires an approved START_FRAME asset');
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
      throw new Error(`FAL_KEYFRAME_MISSING_ON_DISK: ${startFrame.sha256Hash}`);
    }

    if ('keyframeUrl' in request && request.keyframeUrl) {
      return request.keyframeUrl;
    }

    throw new Error('FAL_START_FRAME_REQUIRED: keyframe reference missing');
  }

  async submit(request: GenerationRequest): Promise<SubmissionResult> {
    if (request.executionMode !== 'LIVE') {
      throw new Error('LIVE_ADAPTER_REQUIRES_LIVE_MODE: LiveFalKlingVideoAdapter requires executionMode=LIVE');
    }
    if (request.kind !== 'VIDEO') {
      throw new Error(`fal.ai Kling adapter only supports VIDEO generation, received ${request.kind}`);
    }

    assertAuthorizedFalOrigin(this.submitUrl);
    const imageUrl = await this.resolveImageUrl(request);

    const res = await this.transport(this.submitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Key ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: request.prompt,
        image_url: imageUrl,
        duration: String(request.durationSeconds ?? 5),
        aspect_ratio: request.aspectRatio,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`FAL_HTTP_ERROR: status ${res.status}`);
    }

    const parsed = falQueueSubmitResponseSchema.parse(await res.json());
    assertAuthorizedFalOrigin(parsed.status_url);
    assertAuthorizedFalOrigin(parsed.response_url);

    const providerJobId = encodeFalProviderJobId(parsed.request_id, parsed.status_url, parsed.response_url);
    return {
      attemptId: request.attemptId,
      providerJobId,
      state: 'SUBMITTED',
      executionMode: 'LIVE',
      provenance: 'LIVE_PROVIDER',
      submittedAt: new Date().toISOString(),
    };
  }

  async pollStatus(providerJobId: string): Promise<ProviderStatusUpdate> {
    const { requestId, statusUrl, responseUrl } = parseFalProviderJobId(providerJobId);
    assertAuthorizedFalOrigin(statusUrl);

    const statusRes = await this.transport(statusUrl, {
      method: 'GET',
      headers: {
        Authorization: `Key ${this.apiKey}`,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!statusRes.ok) {
      throw new Error(`FAL_STATUS_HTTP_ERROR: status ${statusRes.status}`);
    }

    const statusRaw = (await statusRes.json()) as unknown;
    const statusParsed = falQueueStatusResponseSchema.parse(statusRaw);

    if (statusParsed.status === 'IN_QUEUE' || statusParsed.status === 'IN_PROGRESS') {
      return {
        providerJobId,
        state: 'RUNNING',
        provenance: 'LIVE_PROVIDER',
        rawResponse: statusRaw,
      };
    }

    if (statusParsed.status === 'FAILED') {
      return {
        providerJobId,
        state: 'FAILED',
        provenance: 'LIVE_PROVIDER',
        errorMessage: `FAL_TASK_FAILED: ${requestId}`,
        billingEvidence: extractFalBillingEvidence(statusRaw, requestId),
        rawResponse: statusRaw,
      };
    }

    assertAuthorizedFalOrigin(responseUrl);
    const resultRes = await this.transport(responseUrl, {
      method: 'GET',
      headers: {
        Authorization: `Key ${this.apiKey}`,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!resultRes.ok) {
      throw new Error(`FAL_RESULT_HTTP_ERROR: status ${resultRes.status}`);
    }

    const resultRaw = (await resultRes.json()) as unknown;
    const resultParsed = falQueueResultResponseSchema.parse(resultRaw);

    return {
      providerJobId,
      state: 'SUCCEEDED',
      provenance: 'LIVE_PROVIDER',
      mediaUrl: resultParsed.video.url,
      locator: { kind: 'REMOTE_URL', url: resultParsed.video.url },
      billingEvidence: extractFalBillingEvidence(resultRaw, requestId),
      rawResponse: resultRaw,
    };
  }

  async reconcile(attemptId: string, providerJobId: string | null): Promise<ReconciliationResult> {
    if (!providerJobId) {
      return {
        attemptId,
        providerJobId: null,
        outcome: 'UNRESOLVED_MANUAL_REVIEW',
        evidence: 'fal.ai queue submission uncertain without persisted requestId',
      };
    }

    const update = await this.pollStatus(providerJobId);
    if (update.state === 'SUCCEEDED') {
      return { attemptId, providerJobId, outcome: 'CONFIRMED_SUCCEEDED', evidence: 'fal.ai queue confirmed COMPLETED' };
    }
    if (update.state === 'RUNNING') {
      return { attemptId, providerJobId, outcome: 'CONFIRMED_RUNNING', evidence: 'fal.ai queue task still running' };
    }
    if (update.billingEvidence?.status === 'CONFIRMED_UNCHARGED') {
      return { attemptId, providerJobId, outcome: 'CONFIRMED_FAILED_NO_CHARGE', evidence: 'fal.ai task failed uncharged' };
    }
    return {
      attemptId,
      providerJobId,
      outcome: 'UNRESOLVED_MANUAL_REVIEW',
      evidence: update.errorMessage ?? 'fal.ai task failed with unconfirmed billing',
    };
  }
}

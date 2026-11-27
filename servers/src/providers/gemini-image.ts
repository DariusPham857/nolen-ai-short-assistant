import { createHash } from 'node:crypto';
import type {
  BillingEvidence,
  GenerationRequest,
  ProviderStatusUpdate,
  ReconciliationResult,
  SubmissionResult,
} from '@nolen/contracts';
import type { ProviderAdapter } from './adapter.js';
import { DEFAULT_IMAGE_MAX_BYTES } from '../lib/remote-download.js';
import { StorageAdapter, storage as defaultStorage } from '../lib/storage.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface LiveGeminiAdapterOptions {
  apiKey?: string;
  model?: string;
  storage?: StorageAdapter;
  transportFn?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
}

const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Extracts inline base64 image data from Gemini API response.
 * Handles interleaved text/image output where parts[0] may be text and a later part holds inlineData.
 */
export function extractGeminiInlineImage(response: unknown): { base64Data: string; mimeType: string } {
  const data = response as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          inlineData?: {
            mimeType?: string;
            data?: string;
          };
        }>;
      };
    }>;
  };

  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('GEMINI_RESPONSE_EMPTY_PARTS');
  }

  const imagePart = parts.find(
    part => typeof part?.inlineData?.data === 'string' && part.inlineData.data.trim().length > 0,
  );

  if (!imagePart?.inlineData?.data) {
    throw new Error('GEMINI_IMAGE_PART_MISSING');
  }

  return {
    base64Data: imagePart.inlineData.data.trim(),
    mimeType: imagePart.inlineData.mimeType || 'image/png',
  };
}

/**
 * Extracts explicit authoritative billing evidence if present on response/headers.
 * Never infers or fabricates realized USD micros from token usage counts or rate card unit prices.
 */
function extractGeminiBillingEvidence(responseJson: unknown, requestId: string | null): BillingEvidence {
  const obj = responseJson as {
    billing?: { realizedChargeUsdMicros?: unknown; evidenceRef?: unknown };
  } | null;

  const rawCharge = obj?.billing?.realizedChargeUsdMicros;
  const rawRef = obj?.billing?.evidenceRef;
  if (typeof rawCharge === 'string' && /^\d+$/.test(rawCharge) && typeof rawRef === 'string' && rawRef.length > 0) {
    return {
      status: 'CONFIRMED_CHARGED',
      realizedChargeUsdMicros: rawCharge,
      evidenceRef: rawRef,
    };
  }

  return {
    status: 'PENDING',
    evidenceRef: requestId ? `gemini:request:${requestId}` : 'gemini:usage-pending',
  };
}

export function parseGeminiProviderJobId(providerJobId: string): { attemptId: string; sha256: string } | null {
  const parts = providerJobId.split(':');
  if (parts.length !== 3 || parts[0] !== 'gemini') return null;
  const [, attemptId, sha256] = parts;
  if (!attemptId || !/^[a-f0-9]{64}$/.test(sha256)) return null;
  return { attemptId, sha256 };
}

/**
 * LIVE Google Gemini image generation adapter (Pathway A: inline base64 decode).
 * Binds generated image SHA-256 directly into durable providerJobId: `gemini:${attemptId}:${sha256}`.
 */
export class LiveGeminiImageAdapter implements ProviderAdapter {
  readonly kind = 'GEMINI' as const;
  readonly executionMode = 'LIVE' as const;
  readonly isFake = false as const;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly storage: StorageAdapter;
  private readonly transport: FetchLike;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly billingByJobId = new Map<string, BillingEvidence>();

  constructor(options: LiveGeminiAdapterOptions = {}) {
    const key = (options.apiKey ?? process.env.GEMINI_API_KEY ?? '').trim();
    if (!key) {
      throw new Error('LIVE_PROVIDER_UNAVAILABLE: GEMINI_API_KEY is not configured');
    }
    this.apiKey = key;
    this.model = options.model ?? DEFAULT_GEMINI_IMAGE_MODEL;
    this.storage = options.storage ?? defaultStorage;
    this.transport = options.transportFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.baseUrl = (options.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
  }

  async submit(request: GenerationRequest): Promise<SubmissionResult> {
    if (request.executionMode !== 'LIVE') {
      throw new Error('LIVE_ADAPTER_REQUIRES_LIVE_MODE: LiveGeminiImageAdapter requires executionMode=LIVE');
    }
    if (request.kind !== 'IMAGE') {
      throw new Error(`Gemini image adapter only supports IMAGE generation, received ${request.kind}`);
    }

    const parts: Array<Record<string, unknown>> = [{ text: request.prompt }];

    if ('schemaVersion' in request && request.schemaVersion === '2') {
      for (const asset of request.inputAssets) {
        const category = asset.source === 'GENERATED_ASSET' ? 'keyframes' : 'references';
        const ext =
          asset.mimeType === 'image/jpeg'
            ? '.jpg'
            : asset.mimeType === 'image/webp'
              ? '.webp'
              : '.png';
        const refFilename = `${asset.sha256Hash}${ext}`;
        if (!this.storage.exists(category, refFilename)) {
          throw new Error(`GEMINI_REFERENCE_ASSET_MISSING: ${category}/${refFilename}`);
        }
        const buf = await this.storage.read(category, refFilename);
        const actualSha = createHash('sha256').update(buf).digest('hex');
        if (actualSha !== asset.sha256Hash) {
          throw new Error(`GEMINI_REFERENCE_HASH_MISMATCH: ${category}/${refFilename}`);
        }
        parts.push({
          inlineData: {
            mimeType: asset.mimeType,
            data: buf.toString('base64'),
          },
        });
      }
    }

    const modelId = 'modelId' in request && request.modelId ? request.modelId : this.model;
    const url = `${this.baseUrl}/models/${encodeURIComponent(modelId)}:generateContent`;

    const res = await this.transport(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`GEMINI_HTTP_ERROR: status ${res.status}`);
    }

    const json = (await res.json()) as unknown;
    const { base64Data } = extractGeminiInlineImage(json);
    const bytes = Buffer.from(base64Data, 'base64');
    if (bytes.byteLength === 0) {
      throw new Error('GEMINI_EMPTY_IMAGE_BYTES');
    }
    if (bytes.byteLength > DEFAULT_IMAGE_MAX_BYTES) {
      throw new Error('PAYLOAD_TOO_LARGE');
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const filename = `${sha256}.png`;
    await this.storage.write('keyframes', filename, bytes);

    const providerJobId = `gemini:${request.attemptId}:${sha256}`;
    const requestId = res.headers?.get?.('x-goog-request-id') ?? null;
    this.billingByJobId.set(providerJobId, extractGeminiBillingEvidence(json, requestId));

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
    const parsed = parseGeminiProviderJobId(providerJobId);
    if (!parsed) {
      return {
        providerJobId,
        state: 'FAILED',
        provenance: 'LIVE_PROVIDER',
        errorMessage: `INVALID_GEMINI_JOB_ID: ${providerJobId}`,
      };
    }

    const filename = `${parsed.sha256}.png`;
    if (!this.storage.exists('keyframes', filename)) {
      return {
        providerJobId,
        state: 'FAILED',
        provenance: 'LIVE_PROVIDER',
        errorMessage: `GEMINI_KEYFRAME_MISSING: ${filename}`,
      };
    }

    const verified = await this.storage.verify('keyframes', filename, parsed.sha256).catch(() => false);
    if (!verified) {
      return {
        providerJobId,
        state: 'FAILED',
        provenance: 'LIVE_PROVIDER',
        errorMessage: `GEMINI_KEYFRAME_HASH_MISMATCH: ${filename}`,
      };
    }

    const billingEvidence = this.billingByJobId.get(providerJobId) ?? {
      status: 'PENDING' as const,
      evidenceRef: `gemini:recovered:${parsed.sha256}`,
    };

    return {
      providerJobId,
      state: 'SUCCEEDED',
      provenance: 'LIVE_PROVIDER',
      locator: {
        kind: 'LOCAL_STORAGE',
        category: 'keyframes',
        filename,
        sha256: parsed.sha256,
      },
      billingEvidence,
    };
  }

  async reconcile(attemptId: string, providerJobId: string | null): Promise<ReconciliationResult> {
    if (!providerJobId) {
      return {
        attemptId,
        providerJobId: null,
        outcome: 'UNRESOLVED_MANUAL_REVIEW',
        evidence: 'Gemini inline submit crashed prior to durable providerJobId persistence',
      };
    }

    const status = await this.pollStatus(providerJobId);
    if (status.state === 'SUCCEEDED') {
      return {
        attemptId,
        providerJobId,
        outcome: 'CONFIRMED_SUCCEEDED',
        evidence: `Verified Gemini inline keyframe on disk for ${providerJobId}`,
      };
    }

    return {
      attemptId,
      providerJobId,
      outcome: 'UNRESOLVED_MANUAL_REVIEW',
      evidence: status.errorMessage ?? `Gemini keyframe missing or invalid for ${providerJobId}`,
    };
  }
}

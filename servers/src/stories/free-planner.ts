import {
  proposalToStoryContentV2,
  storyProposalV2Schema,
  type Finding,
  type ProposalProvenance,
  type StoryContentV2,
} from '@nolen/contracts';
import { ApiFailure } from '../http/errors.js';
import { referenceErrors, validate } from './domain.js';

export const PINNED_FREE_PLANNER_MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_GENERATE_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';
export const GEMINI_MODEL_META_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite';

export const FREE_PLANNER_TIMEOUT_MS = 60_000;
export const FREE_PLANNER_MAX_OUTPUT_TOKENS = 16_384;
export const FREE_PLANNER_MAX_RESPONSE_BYTES = 524_288; // 512 KiB

export type FreePlannerEnv = {
  GEMINI_API_KEY?: string;
  GEMINI_NO_BILLING_ATTESTED?: string;
  GEMINI_FREE_PLANNER_MODEL?: string;
};

export type FreePlannerPreflightResult = {
  credentialValid: boolean | 'UNKNOWN';
  modelAvailable: boolean | 'UNKNOWN';
  billingTierStatus: 'NO_BILLING_ATTESTED' | 'UNKNOWN';
  pinnedModel: string;
  configuredModel: string;
  ready: boolean;
  reasons: string[];
};

export type FreePlannerProposalResult = {
  provenance: ProposalProvenance;
  content: StoryContentV2;
  findings: Finding[];
};

/** JSON Schema subset compatible with Gemini structured JSON output for StoryProposalV2. */
const STORY_PROPOSAL_V2_JSON_SCHEMA = {
  type: 'object',
  required: ['script', 'storyBible', 'scenes'],
  properties: {
    script: { type: 'string' },
    storyBible: {
      type: 'object',
      required: ['schemaVersion', 'narrative', 'characters', 'wardrobes', 'props', 'locations', 'styleRefs'],
      properties: {
        schemaVersion: { type: 'string', enum: ['2'] },
        narrative: { type: 'string' },
        characters: { type: 'array', items: { type: 'object', required: ['id', 'name', 'description'], properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } } } },
        wardrobes: { type: 'array', items: { type: 'object', required: ['id', 'name', 'description'], properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } } } },
        props: { type: 'array', items: { type: 'object', required: ['id', 'name', 'description', 'hero'], properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, hero: { type: 'boolean' } } } },
        locations: { type: 'array', items: { type: 'object', required: ['id', 'name', 'description'], properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } } } },
        styleRefs: { type: 'array', items: { type: 'object', required: ['id', 'name', 'description'], properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } } } },
      },
    },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['clientRef', 'title', 'shots'],
        properties: {
          clientRef: { type: 'string' },
          title: { type: 'string' },
          shots: {
            type: 'array',
            items: {
              type: 'object',
              required: ['clientRef', 'spec'],
              properties: {
                clientRef: { type: 'string' },
                spec: {
                  type: 'object',
                  required: ['schemaVersion', 'shotType', 'durationSeconds', 'prompt', 'negativePrompt', 'styleRefId', 'subjectIds', 'locationId', 'continuity', 'intendedTransitions', 'camera'],
                  properties: {
                    schemaVersion: { type: 'string', enum: ['2'] },
                    shotType: { type: 'string', enum: ['CHARACTER', 'ACTION', 'DIALOGUE', 'ESTABLISHING', 'BROLL', 'INSERT', 'PRODUCT', 'OTHER'] },
                    durationSeconds: { type: 'integer' },
                    prompt: { type: 'string' },
                    negativePrompt: { type: 'string' },
                    styleRefId: { type: 'string' },
                    subjectIds: { type: 'array', items: { type: 'string' } },
                    locationId: { type: 'string' },
                    continuity: {
                      type: 'object',
                      required: ['start', 'end'],
                      properties: {
                        start: {
                          type: 'object',
                          required: ['locationId', 'lighting', 'propIds', 'characterStates'],
                          properties: {
                            locationId: { type: 'string' },
                            lighting: { type: 'string' },
                            propIds: { type: 'array', items: { type: 'string' } },
                            characterStates: {
                              type: 'array',
                              items: {
                                type: 'object',
                                required: ['characterId', 'wardrobeId', 'pose', 'heldPropIds'],
                                properties: {
                                  characterId: { type: 'string' },
                                  wardrobeId: { type: 'string' },
                                  pose: { type: 'string' },
                                  heldPropIds: { type: 'array', items: { type: 'string' } },
                                },
                              },
                            },
                          },
                        },
                        end: {
                          type: 'object',
                          required: ['locationId', 'lighting', 'propIds', 'characterStates'],
                          properties: {
                            locationId: { type: 'string' },
                            lighting: { type: 'string' },
                            propIds: { type: 'array', items: { type: 'string' } },
                            characterStates: {
                              type: 'array',
                              items: {
                                type: 'object',
                                required: ['characterId', 'wardrobeId', 'pose', 'heldPropIds'],
                                properties: {
                                  characterId: { type: 'string' },
                                  wardrobeId: { type: 'string' },
                                  pose: { type: 'string' },
                                  heldPropIds: { type: 'array', items: { type: 'string' } },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                    intendedTransitions: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['field', 'reason'],
                        properties: {
                          field: { type: 'string', enum: ['wardrobe', 'heldProps', 'pose', 'location', 'lighting', 'props'] },
                          reason: { type: 'string' },
                        },
                      },
                    },
                    camera: {
                      type: 'object',
                      required: ['angle', 'framing', 'movement'],
                      properties: {
                        angle: { type: 'string', enum: ['EYE_LEVEL', 'HIGH_ANGLE', 'LOW_ANGLE', 'OVERHEAD', 'DUTCH_ANGLE', 'POV', 'OVER_THE_SHOULDER'] },
                        framing: { type: 'string' },
                        movement: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

/** Enforce R0 billing attestation, API key presence, and pinned model before any network call. */
export function assertFreePlannerConfig(env: FreePlannerEnv = process.env): { apiKey: string } {
  if (env.GEMINI_NO_BILLING_ATTESTED !== 'true') {
    throw new ApiFailure(
      422,
      'FREE_PLANNER_BILLING_UNATTESTED',
      'GEMINI_NO_BILLING_ATTESTED must be set to "true" before calling Gemini Free Planner',
    );
  }
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new ApiFailure(503, 'FREE_PLANNER_UNAVAILABLE', 'GEMINI_API_KEY is not configured');
  }
  const configuredModel = env.GEMINI_FREE_PLANNER_MODEL?.trim();
  if (configuredModel && configuredModel !== PINNED_FREE_PLANNER_MODEL) {
    throw new ApiFailure(
      503,
      'FREE_PLANNER_UNAVAILABLE',
      `Free Planner is pinned to ${PINNED_FREE_PLANNER_MODEL}`,
    );
  }
  return { apiKey };
}

/** Non-blocking CLI preflight reporting credential, model availability, and attestation status without leaking keys. */
export async function checkFreePlannerPreflight(deps?: {
  env?: FreePlannerEnv;
  fetchImpl?: typeof fetch;
}): Promise<FreePlannerPreflightResult> {
  const env = deps?.env ?? process.env;
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const configuredModel = env.GEMINI_FREE_PLANNER_MODEL?.trim() || PINNED_FREE_PLANNER_MODEL;
  const billingTierStatus: 'NO_BILLING_ATTESTED' | 'UNKNOWN' =
    env.GEMINI_NO_BILLING_ATTESTED === 'true' ? 'NO_BILLING_ATTESTED' : 'UNKNOWN';

  const reasons: string[] = [];
  if (billingTierStatus !== 'NO_BILLING_ATTESTED') {
    reasons.push('GEMINI_NO_BILLING_ATTESTED is not "true"');
  }
  if (configuredModel !== PINNED_FREE_PLANNER_MODEL) {
    reasons.push(`Configured model differs from pinned ${PINNED_FREE_PLANNER_MODEL}`);
  }

  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    reasons.push('GEMINI_API_KEY is missing');
    return {
      credentialValid: false,
      modelAvailable: false,
      billingTierStatus,
      pinnedModel: PINNED_FREE_PLANNER_MODEL,
      configuredModel,
      ready: false,
      reasons,
    };
  }

  let credentialValid: boolean | 'UNKNOWN' = 'UNKNOWN';
  let modelAvailable: boolean | 'UNKNOWN' = 'UNKNOWN';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(GEMINI_MODEL_META_ENDPOINT, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
      redirect: 'error',
      signal: controller.signal,
    });
    await response.body?.cancel();
    if (response.status === 200) {
      credentialValid = true;
      modelAvailable = true;
    } else if (response.status === 401 || response.status === 403) {
      credentialValid = false;
      modelAvailable = false;
      reasons.push(`Credential rejected by Google (${response.status})`);
    } else if (response.status === 404) {
      credentialValid = true;
      modelAvailable = false;
      reasons.push(`Pinned model ${PINNED_FREE_PLANNER_MODEL} not available (404)`);
    } else {
      reasons.push(`Unexpected metadata status (${response.status})`);
    }
  } catch {
    reasons.push('Network check failed while querying Google model metadata');
  } finally {
    clearTimeout(timer);
  }

  const ready =
    credentialValid === true &&
    modelAvailable === true &&
    billingTierStatus === 'NO_BILLING_ATTESTED' &&
    configuredModel === PINNED_FREE_PLANNER_MODEL;

  return {
    credentialValid,
    modelAvailable,
    billingTierStatus,
    pinnedModel: PINNED_FREE_PLANNER_MODEL,
    configuredModel,
    ready,
    reasons,
  };
}

/** Read response bytes with an explicit cap before JSON parsing, preserving timeout/stream error mapping. */
async function readBoundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      throw new ApiFailure(502, 'FREE_PLANNER_INVALID_OUTPUT', 'Gemini response exceeded maximum size');
    }
  }

  if (!response.body) {
    try {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new ApiFailure(502, 'FREE_PLANNER_INVALID_OUTPUT', 'Gemini response exceeded maximum size');
      }
      return text;
    } catch (err) {
      if (err instanceof ApiFailure) throw err;
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new ApiFailure(504, 'FREE_PLANNER_TIMEOUT', 'Gemini Free Planner request timed out');
      }
      throw new ApiFailure(502, 'FREE_PLANNER_UPSTREAM_FAILED', 'Gemini Free Planner stream read failed');
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new ApiFailure(502, 'FREE_PLANNER_INVALID_OUTPUT', 'Gemini response exceeded maximum size');
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    if (err instanceof ApiFailure) throw err;
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw new ApiFailure(504, 'FREE_PLANNER_TIMEOUT', 'Gemini Free Planner request timed out');
    }
    throw new ApiFailure(502, 'FREE_PLANNER_UPSTREAM_FAILED', 'Gemini Free Planner stream read failed');
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(combined);
}

function buildPlannerPrompt(input: { brief: string; durationTargetSeconds: number; aspectRatio: string }): string {
  return [
    'Generate a structured Story v2 JSON proposal for a short film based on the brief below.',
    'Write all creative text (script, narrative, titles, descriptions, prompts) in the same language as the brief.',
    `Target total duration: ${input.durationTargetSeconds} seconds. Total durationSeconds across all shots must be 30–60s and match targetDurationSeconds (${input.durationTargetSeconds}s).`,
    `Aspect ratio: ${input.aspectRatio}.`,
    'Rules:',
    '- Use schemaVersion "2" for storyBible and every shot spec.',
    '- Keep 1 to 10 shots total across scenes; each shot durationSeconds is an integer from 1 to 60, and the sum across all shots must be 30–60s matching targetDurationSeconds.',
    '- Every locationId, styleRefId, subjectIds, characterId, wardrobeId, propId, and heldPropIds used in shots must exist in storyBible.',
    '- Every shot spec.locationId must match continuity.start.locationId and continuity.end.locationId.',
    '- Every character in subjectIds must have a matching entry in both continuity.start.characterStates and continuity.end.characterStates.',
    '- IDENTITY_LOCK: Keep the exact same styleRefId for any recurring character across all shots in which they appear.',
    '- Adjacent shot continuity (including across scene boundaries): for every i > 0, shot[i].continuity.start must copy shot[i-1].continuity.end verbatim for locationId, lighting, propIds, and each shared character\'s wardrobeId, heldPropIds, and pose unless an intentional change occurs.',
    '- intendedTransitions: for any intentional change between shot[i-1].continuity.end and shot[i].continuity.start, declare { field, reason } in shot[i].intendedTransitions (where field is one of wardrobe, heldProps, pose, location, lighting, props); leave intendedTransitions empty ([]) when unchanged.',
    '- Do not include database UUIDs, id fields, expectedShotRevisionId, referenceAssetIds, or keyframeOverride.',
    '',
    `Brief:\n${input.brief}`,
  ].join('\n');
}

/** Call Gemini Free Planner once (no retry, no fallback) and return validated StoryContentV2 + pure continuity findings. */
export async function generateGeminiStoryProposal(
  input: { brief: string; durationTargetSeconds: number; aspectRatio: string },
  deps?: {
    env?: FreePlannerEnv;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<FreePlannerProposalResult> {
  const { apiKey } = assertFreePlannerConfig(deps?.env);
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const timeoutMs = deps?.timeoutMs ?? FREE_PLANNER_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let rawBody: string;
  try {
    let response: Response;
    try {
      response = await fetchImpl(GEMINI_GENERATE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: buildPlannerPrompt(input) }] }],
          generationConfig: {
            candidateCount: 1,
            responseMimeType: 'application/json',
            responseJsonSchema: STORY_PROPOSAL_V2_JSON_SCHEMA,
            maxOutputTokens: FREE_PLANNER_MAX_OUTPUT_TOKENS,
          },
        }),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new ApiFailure(504, 'FREE_PLANNER_TIMEOUT', 'Gemini Free Planner request timed out');
      }
      throw new ApiFailure(502, 'FREE_PLANNER_UPSTREAM_FAILED', 'Gemini Free Planner network request failed');
    }

    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw new ApiFailure(503, 'FREE_PLANNER_UNAVAILABLE', 'Gemini Free Planner credentials or model unavailable');
      }
      if (response.status === 429) {
        throw new ApiFailure(429, 'FREE_PLANNER_RATE_LIMITED', 'Gemini Free Planner rate limit exceeded');
      }
      throw new ApiFailure(502, 'FREE_PLANNER_UPSTREAM_FAILED', 'Gemini Free Planner upstream request failed');
    }

    rawBody = await readBoundedText(response, FREE_PLANNER_MAX_RESPONSE_BYTES, controller.signal);
  } finally {
    clearTimeout(timer);
  }
  let envelope: {
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{
      finishReason?: string;
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  try {
    envelope = JSON.parse(rawBody) as typeof envelope;
  } catch {
    throw new ApiFailure(502, 'FREE_PLANNER_INVALID_OUTPUT', 'Gemini returned invalid response JSON');
  }

  if (envelope.promptFeedback?.blockReason) {
    throw new ApiFailure(422, 'FREE_PLANNER_CONTENT_BLOCKED', 'Gemini blocked the story proposal request');
  }

  const candidate = envelope.candidates?.[0];
  if (!candidate) {
    throw new ApiFailure(502, 'FREE_PLANNER_INVALID_OUTPUT', 'Gemini returned no story proposal candidate');
  }
  if (candidate.finishReason === 'SAFETY') {
    throw new ApiFailure(422, 'FREE_PLANNER_CONTENT_BLOCKED', 'Gemini blocked the story proposal output');
  }
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new ApiFailure(502, 'FREE_PLANNER_INVALID_OUTPUT', 'Gemini output was truncated at token limit');
  }

  const rawText = candidate.content?.parts?.find(p => typeof p.text === 'string')?.text;
  if (!rawText) {
    throw new ApiFailure(502, 'FREE_PLANNER_INVALID_OUTPUT', 'Gemini candidate contained no JSON text');
  }

  let parsedCandidate: unknown;
  try {
    parsedCandidate = JSON.parse(rawText);
  } catch {
    throw new ApiFailure(502, 'FREE_PLANNER_INVALID_OUTPUT', 'Gemini candidate output is not valid JSON');
  }

  const proposalResult = storyProposalV2Schema.safeParse(parsedCandidate);
  if (!proposalResult.success) {
    throw new ApiFailure(502, 'FREE_PLANNER_INVALID_OUTPUT', 'Gemini output failed Story v2 schema validation');
  }

  const content = proposalToStoryContentV2(proposalResult.data);
  const refErrors = referenceErrors(content);
  if (refErrors.length > 0) {
    throw new ApiFailure(502, 'FREE_PLANNER_INVALID_OUTPUT', 'Gemini output failed Story Bible reference validation');
  }

  const findings = validate(content, input.durationTargetSeconds);
  return {
    provenance: {
      source: 'LIVE_LLM',
      model: PINNED_FREE_PLANNER_MODEL,
      liveInference: true,
    },
    content,
    findings,
  };
}

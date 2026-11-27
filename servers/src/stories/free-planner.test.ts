import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../http/errors.js';
import { checkFreePlannerPreflight, generateGeminiStoryProposal, PINNED_FREE_PLANNER_MODEL } from './free-planner.js';

function validProposalJson() {
  return JSON.stringify({
    script: 'A short film about a desk lamp.',
    storyBible: {
      schemaVersion: '2',
      narrative: 'Warm realism',
      characters: [{ id: 'hero', name: 'Hero', description: 'Adult' }],
      wardrobes: [{ id: 'coat', name: 'Coat', description: 'Brown coat' }],
      props: [{ id: 'lamp', name: 'Lamp', description: 'Desk lamp', hero: true }],
      locations: [{ id: 'room', name: 'Room', description: 'Quiet room' }],
      styleRefs: [{ id: 'cinema', name: 'Cinema', description: 'Warm light' }],
    },
    scenes: [{
      clientRef: 'scene-1',
      title: 'Scene 1',
      shots: [{
        clientRef: 'shot-1',
        spec: {
          schemaVersion: '2',
          shotType: 'ESTABLISHING',
          durationSeconds: 30,
          prompt: 'Wide shot of the room',
          negativePrompt: '',
          styleRefId: 'cinema',
          subjectIds: ['hero'],
          locationId: 'room',
          continuity: {
            start: { locationId: 'room', lighting: 'Warm', propIds: ['lamp'], characterStates: [{ characterId: 'hero', wardrobeId: 'coat', pose: 'Standing', heldPropIds: [] }] },
            end: { locationId: 'room', lighting: 'Warm', propIds: ['lamp'], characterStates: [{ characterId: 'hero', wardrobeId: 'coat', pose: 'Standing', heldPropIds: [] }] },
          },
          intendedTransitions: [],
          camera: { angle: 'EYE_LEVEL', framing: 'Wide', movement: 'Static' },
        },
      }],
    }],
  });
}

function geminiOkResponse(text = validProposalJson(), finishReason = 'STOP') {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

async function expectApiFailure(fn: () => Promise<unknown>, status: number, code: string) {
  try {
    await fn();
    throw new Error(`Expected ApiFailure(${status}, ${code}) but succeeded`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as ApiFailure).status).toBe(status);
    expect((err as ApiFailure).code).toBe(code);
  }
}

describe('FP-02a billing guard and preflight (R0)', () => {
  it('rejects missing or non-"true" GEMINI_NO_BILLING_ATTESTED with 422 before fetch (FP-AT-02)', async () => {
    const fetchMock = vi.fn();
    for (const val of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      await expectApiFailure(
        () => generateGeminiStoryProposal(
          { brief: 'Test brief', durationTargetSeconds: 30, aspectRatio: '9:16' },
          { env: { GEMINI_API_KEY: 'secret-key', GEMINI_NO_BILLING_ATTESTED: val }, fetchImpl: fetchMock as unknown as typeof fetch },
        ),
        422,
        'FREE_PLANNER_BILLING_UNATTESTED',
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects missing API key or non-pinned model with 503 before fetch (FP-AT-02)', async () => {
    const fetchMock = vi.fn();
    await expectApiFailure(
      () => generateGeminiStoryProposal(
        { brief: 'Test brief', durationTargetSeconds: 30, aspectRatio: '9:16' },
        { env: { GEMINI_NO_BILLING_ATTESTED: 'true' }, fetchImpl: fetchMock as unknown as typeof fetch },
      ),
      503,
      'FREE_PLANNER_UNAVAILABLE',
    );
    await expectApiFailure(
      () => generateGeminiStoryProposal(
        { brief: 'Test brief', durationTargetSeconds: 30, aspectRatio: '9:16' },
        { env: { GEMINI_API_KEY: 'secret-key', GEMINI_NO_BILLING_ATTESTED: 'true', GEMINI_FREE_PLANNER_MODEL: 'gemini-2.5-pro' }, fetchImpl: fetchMock as unknown as typeof fetch },
      ),
      503,
      'FREE_PLANNER_UNAVAILABLE',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preflight reports credential, model availability and billingTierStatus without leaking key (FP-AT-02)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ name: `models/${PINNED_FREE_PLANNER_MODEL}` }), { status: 200 }));
    const res = await checkFreePlannerPreflight({
      env: { GEMINI_API_KEY: 'super-secret-value', GEMINI_NO_BILLING_ATTESTED: 'true' },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(res.credentialValid).toBe(true);
    expect(res.modelAvailable).toBe(true);
    expect(res.billingTierStatus).toBe('NO_BILLING_ATTESTED');
    expect(res.ready).toBe(true);
    expect(JSON.stringify(res)).not.toContain('super-secret-value');

    const failFetch = vi.fn(async () => { throw new Error('network down'); });
    const netFail = await checkFreePlannerPreflight({
      env: { GEMINI_API_KEY: 'super-secret-value', GEMINI_NO_BILLING_ATTESTED: 'false' },
      fetchImpl: failFetch as unknown as typeof fetch,
    });
    expect(netFail.credentialValid).toBe('UNKNOWN');
    expect(netFail.modelAvailable).toBe('UNKNOWN');
    expect(netFail.billingTierStatus).toBe('UNKNOWN');
    expect(netFail.ready).toBe(false);
  });

  it('passes redirect: error and cancels unused body on metadata preflight GET (FP-AT-06 prerequisite)', async () => {
    const cancelSpy = vi.fn(async () => undefined);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"name":"models/gemini-3.5-flash-lite"}'));
      },
      cancel: cancelSpy,
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    const res = await checkFreePlannerPreflight({
      env: { GEMINI_API_KEY: 'secret-key', GEMINI_NO_BILLING_ATTESTED: 'true' },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(res.ready).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe('error');
    expect(cancelSpy).toHaveBeenCalled();
  });
});

describe('FP-02b Gemini transport and validation (R1)', () => {
  const validEnv = { GEMINI_API_KEY: 'secret-key', GEMINI_NO_BILLING_ATTESTED: 'true' };
  const filmInput = { brief: 'A fictional lamp story', durationTargetSeconds: 45, aspectRatio: '9:16' };

  it('sends fixed URL, x-goog-api-key header, structured JSON, 1 candidate, no tools/cache, and returns LIVE_LLM provenance + findings (FP-AT-03)', async () => {
    const fetchMock = vi.fn(async () => geminiOkResponse());
    const result = await generateGeminiStoryProposal(filmInput, {
      env: validEnv,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(url).not.toContain('secret-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
    const body = JSON.parse(init.body as string) as {
      generationConfig: { candidateCount: number; responseMimeType: string; maxOutputTokens: number };
      tools?: unknown;
      cachedContent?: unknown;
    };
    expect(body.generationConfig.candidateCount).toBe(1);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.maxOutputTokens).toBe(16384);
    expect(body.tools).toBeUndefined();
    expect(body.cachedContent).toBeUndefined();

    expect(result.provenance).toEqual({
      source: 'LIVE_LLM',
      model: 'gemini-3.5-flash-lite',
      liveInference: true,
    });
    expect(result.content.storyBible.schemaVersion).toBe('2');
    // 30s shot vs 45s target -> TARGET_DURATION warning finding, not 502
    expect(result.findings.some(f => f.code === 'TARGET_DURATION')).toBe(true);
  });

  it('includes IDENTITY_LOCK, end->start continuity, intendedTransitions, and 30-60s targetDurationSeconds rules in outgoing prompt', async () => {
    const fetchMock = vi.fn(async () => geminiOkResponse());
    await generateGeminiStoryProposal(filmInput, {
      env: validEnv,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    const promptText = body.contents[0].parts[0].text;

    expect(promptText).toContain('IDENTITY_LOCK');
    expect(promptText).toContain('styleRefId');
    expect(promptText).toContain('shot[i].continuity.start');
    expect(promptText).toContain('shot[i-1].continuity.end');
    for (const field of ['locationId', 'lighting', 'propIds', 'wardrobeId', 'heldPropIds', 'pose']) {
      expect(promptText).toContain(field);
    }
    expect(promptText).toContain('intendedTransitions');
    expect(promptText).toContain('field');
    expect(promptText).toContain('reason');
    expect(promptText).toContain('30–60s');
    expect(promptText).toContain('targetDurationSeconds (45s)');
  });

  it('maps upstream HTTP, timeout, safety, MAX_TOKENS, malformed JSON, reference error, and >512 KiB stream without retrying (FP-AT-03)', async () => {
    for (const [status, expectedStatus, expectedCode] of [
      [401, 503, 'FREE_PLANNER_UNAVAILABLE'],
      [403, 503, 'FREE_PLANNER_UNAVAILABLE'],
      [404, 503, 'FREE_PLANNER_UNAVAILABLE'],
      [429, 429, 'FREE_PLANNER_RATE_LIMITED'],
      [500, 502, 'FREE_PLANNER_UPSTREAM_FAILED'],
    ] as const) {
      const fetchMock = vi.fn(async () => new Response('err', { status }));
      await expectApiFailure(
        () => generateGeminiStoryProposal(filmInput, { env: validEnv, fetchImpl: fetchMock as unknown as typeof fetch }),
        expectedStatus,
        expectedCode,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }

    // Timeout
    const abortFetch = vi.fn(async (_u: string, init?: RequestInit) => {
      return await new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
      });
    });
    await expectApiFailure(
      () => generateGeminiStoryProposal(filmInput, { env: validEnv, fetchImpl: abortFetch as unknown as typeof fetch, timeoutMs: 10 }),
      504,
      'FREE_PLANNER_TIMEOUT',
    );
    expect(abortFetch).toHaveBeenCalledTimes(1);

    // Safety block
    const safetyFetch = vi.fn(async () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 }));
    await expectApiFailure(
      () => generateGeminiStoryProposal(filmInput, { env: validEnv, fetchImpl: safetyFetch as unknown as typeof fetch }),
      422,
      'FREE_PLANNER_CONTENT_BLOCKED',
    );

    // MAX_TOKENS
    const maxTokFetch = vi.fn(async () => geminiOkResponse(validProposalJson(), 'MAX_TOKENS'));
    await expectApiFailure(
      () => generateGeminiStoryProposal(filmInput, { env: validEnv, fetchImpl: maxTokFetch as unknown as typeof fetch }),
      502,
      'FREE_PLANNER_INVALID_OUTPUT',
    );

    // Invalid JSON
    const badJsonFetch = vi.fn(async () => geminiOkResponse('{not-json'));
    await expectApiFailure(
      () => generateGeminiStoryProposal(filmInput, { env: validEnv, fetchImpl: badJsonFetch as unknown as typeof fetch }),
      502,
      'FREE_PLANNER_INVALID_OUTPUT',
    );

    // Reference error (unknown characterId)
    const badRef = JSON.parse(validProposalJson()) as {
      scenes: Array<{ shots: Array<{ spec: { subjectIds: string[] } }> }>;
    };
    badRef.scenes[0].shots[0].spec.subjectIds = ['missing-char'];
    const badRefFetch = vi.fn(async () => geminiOkResponse(JSON.stringify(badRef)));
    await expectApiFailure(
      () => generateGeminiStoryProposal(filmInput, { env: validEnv, fetchImpl: badRefFetch as unknown as typeof fetch }),
      502,
      'FREE_PLANNER_INVALID_OUTPUT',
    );

    // Oversized stream > 512 KiB
    const bigChunk = new Uint8Array(600 * 1024).fill(65);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bigChunk);
        controller.close();
      },
    });
    const bigFetch = vi.fn(async () => new Response(stream, { status: 200 }));
    await expectApiFailure(
      () => generateGeminiStoryProposal(filmInput, { env: validEnv, fetchImpl: bigFetch as unknown as typeof fetch }),
      502,
      'FREE_PLANNER_INVALID_OUTPUT',
    );

    // redirect: 'error' is set on generation POST
    const redirectCheckFetch = vi.fn(async () => geminiOkResponse());
    await generateGeminiStoryProposal(filmInput, { env: validEnv, fetchImpl: redirectCheckFetch as unknown as typeof fetch });
    const [, postInit] = redirectCheckFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(postInit.redirect).toBe('error');

    // Headers arrive immediately, body stream hangs past deadline -> 504 FREE_PLANNER_TIMEOUT
    const hangingFetch = vi.fn(async (_u: string, init?: RequestInit) => {
      const hangingStream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          });
        },
      });
      return new Response(hangingStream, { status: 200 });
    });
    await expectApiFailure(
      () => generateGeminiStoryProposal(filmInput, { env: validEnv, fetchImpl: hangingFetch as unknown as typeof fetch, timeoutMs: 15 }),
      504,
      'FREE_PLANNER_TIMEOUT',
    );
    expect(hangingFetch).toHaveBeenCalledTimes(1);

    // Non-timeout stream read error -> 502 FREE_PLANNER_UPSTREAM_FAILED
    const brokenStream = new ReadableStream({
      start(controller) {
        controller.error(new Error('socket reset'));
      },
    });
    const brokenFetch = vi.fn(async () => new Response(brokenStream, { status: 200 }));
    await expectApiFailure(
      () => generateGeminiStoryProposal(filmInput, { env: validEnv, fetchImpl: brokenFetch as unknown as typeof fetch }),
      502,
      'FREE_PLANNER_UPSTREAM_FAILED',
    );
    expect(brokenFetch).toHaveBeenCalledTimes(1);
  });
});

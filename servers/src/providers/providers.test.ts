import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createProviderAdapter,
  createFakeProviderAdapter,
  LiveGeminiImageAdapter,
  LiveRunwayVideoAdapter,
  LiveFalKlingVideoAdapter,
} from './index.js';
import { StorageAdapter } from '../lib/storage.js';
import type { GenerationRequest } from '@nolen/contracts';

describe('Provider Adapters (PD-02 / BLOCK 3)', () => {
  const baseImageRequest: GenerationRequest = {
    attemptId: '11111111-1111-4111-8111-111111111111',
    filmId: '22222222-2222-4222-8222-222222222222',
    kind: 'IMAGE',
    provider: 'GEMINI',
    executionMode: 'REPLAY',
    prompt: 'A cyberpunk ramen stall in rainy Neo-Seoul',
    aspectRatio: '9:16',
  };

  const baseVideoRequest: GenerationRequest = {
    attemptId: '33333333-3333-4333-8333-333333333333',
    filmId: '22222222-2222-4222-8222-222222222222',
    kind: 'VIDEO',
    provider: 'RUNWAY',
    executionMode: 'REPLAY',
    prompt: 'Slow dolly zoom into character eyes',
    aspectRatio: '9:16',
    keyframeAssetId: '44444444-4444-4444-8444-444444444444',
  };

  it('submits and polls Fake Gemini adapter with REPLAY provenance', async () => {
    const adapter = createFakeProviderAdapter('GEMINI');
    expect(adapter.kind).toBe('GEMINI');
    expect(adapter.executionMode).toBe('REPLAY');
    expect(adapter.isFake).toBe(true);

    const result = await adapter.submit(baseImageRequest);
    expect(result.state).toBe('SUBMITTED');
    expect(result.executionMode).toBe('REPLAY');
    expect(result.provenance).toBe('REPLAY_FIXTURE');
    expect(result.providerJobId).toBe(`gemini-${baseImageRequest.attemptId}`);

    const status = await adapter.pollStatus(result.providerJobId);
    expect(status.state).toBe('SUCCEEDED');
    expect(status.provenance).toBe('REPLAY_FIXTURE');
    expect(status.mediaUrl).toBeUndefined();
    expect(status.locator).toEqual({
      kind: 'REPLAY_FIXTURE',
      packVersion: 'v1',
      fixtureId: 'default-gemini-image-9-16',
    });

    const reconciliation = await adapter.reconcile(baseImageRequest.attemptId, result.providerJobId);
    expect(reconciliation.outcome).toBe('CONFIRMED_SUCCEEDED');
  });

  it('submits and polls Fake Runway adapter with REPLAY provenance', async () => {
    const adapter = createFakeProviderAdapter('RUNWAY');
    expect(adapter.kind).toBe('RUNWAY');
    expect(adapter.executionMode).toBe('REPLAY');
    expect(adapter.isFake).toBe(true);

    const result = await adapter.submit(baseVideoRequest);
    expect(result.state).toBe('SUBMITTED');
    expect(result.executionMode).toBe('REPLAY');
    expect(result.provenance).toBe('REPLAY_FIXTURE');
    expect(result.providerJobId).toBe(`runway-task-${baseVideoRequest.attemptId}`);

    const status = await adapter.pollStatus(result.providerJobId);
    expect(status.state).toBe('SUCCEEDED');
    expect(status.provenance).toBe('REPLAY_FIXTURE');
    expect(status.mediaUrl).toBeUndefined();
    expect(status.locator).toEqual({
      kind: 'REPLAY_FIXTURE',
      packVersion: 'v1',
      fixtureId: 'default-runway-video-9-16',
    });
  });

  it('submits and polls Fake fal.ai Kling adapter with REPLAY provenance', async () => {
    const adapter = createFakeProviderAdapter('FAL_KLING');
    expect(adapter.kind).toBe('FAL_KLING');

    const result = await adapter.submit({ ...baseVideoRequest, provider: 'FAL_KLING' });
    expect(result.state).toBe('SUBMITTED');
    expect(result.executionMode).toBe('REPLAY');
    expect(result.provenance).toBe('REPLAY_FIXTURE');

    const status = await adapter.pollStatus(result.providerJobId);
    expect(status.state).toBe('SUCCEEDED');
    expect(status.provenance).toBe('REPLAY_FIXTURE');
    expect(status.mediaUrl).toBeUndefined();
    expect(status.locator).toEqual({
      kind: 'REPLAY_FIXTURE',
      packVersion: 'v1',
      fixtureId: 'default-fal_kling-video-9-16',
    });
  });

  it('handles LocalPanZoom adapter deterministically with REPLAY provenance', async () => {
    const adapter = createFakeProviderAdapter('LOCAL_PAN_ZOOM');
    expect(adapter.kind).toBe('LOCAL_PAN_ZOOM');

    const result = await adapter.submit({ ...baseVideoRequest, provider: 'LOCAL_PAN_ZOOM' });
    expect(result.state).toBe('SUCCEEDED');
    expect(result.executionMode).toBe('REPLAY');
    expect(result.provenance).toBe('REPLAY_FIXTURE');

    const status = await adapter.pollStatus(result.providerJobId);
    expect(status.state).toBe('SUCCEEDED');
    expect(status.provenance).toBe('REPLAY_FIXTURE');
    expect(status.mediaUrl).toBeUndefined();
    expect(status.locator).toEqual({
      kind: 'REPLAY_FIXTURE',
      packVersion: 'v1',
      fixtureId: 'default-local_pan_zoom-video-9-16',
    });
  });

  it('fails closed when attempting to request LIVE mode from fake adapters', async () => {
    const gemini = createFakeProviderAdapter('GEMINI');
    await expect(gemini.submit({ ...baseImageRequest, executionMode: 'LIVE' })).rejects.toThrow(
      'FAKE_TRANSPORT_FORBIDDEN_IN_LIVE',
    );

    const runway = createFakeProviderAdapter('RUNWAY');
    await expect(runway.submit({ ...baseVideoRequest, executionMode: 'LIVE' })).rejects.toThrow(
      'FAKE_TRANSPORT_FORBIDDEN_IN_LIVE',
    );

    const falKling = createFakeProviderAdapter('FAL_KLING');
    await expect(falKling.submit({ ...baseVideoRequest, provider: 'FAL_KLING', executionMode: 'LIVE' })).rejects.toThrow(
      'FAKE_TRANSPORT_FORBIDDEN_IN_LIVE',
    );
  });

  it('createProviderAdapter fails closed in LIVE mode for unconfigured live providers', () => {
    const prevGem = process.env.GEMINI_API_KEY;
    const prevRw = process.env.RUNWAY_API_KEY;
    const prevFal = process.env.FAL_API_KEY;
    const prevFalLegacy = process.env.FAL_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.RUNWAY_API_KEY;
    delete process.env.FAL_API_KEY;
    delete process.env.FAL_KEY;
    try {
      expect(() => createProviderAdapter('GEMINI', 'LIVE')).toThrow('LIVE_PROVIDER_UNAVAILABLE');
      expect(() => createProviderAdapter('RUNWAY', 'LIVE')).toThrow('LIVE_PROVIDER_UNAVAILABLE');
      expect(() => createProviderAdapter('FAL_KLING', 'LIVE')).toThrow('LIVE_PROVIDER_UNAVAILABLE');
    } finally {
      if (prevGem !== undefined) process.env.GEMINI_API_KEY = prevGem;
      if (prevRw !== undefined) process.env.RUNWAY_API_KEY = prevRw;
      if (prevFal !== undefined) process.env.FAL_API_KEY = prevFal;
      if (prevFalLegacy !== undefined) process.env.FAL_KEY = prevFalLegacy;
    }
  });

  it('rejects unsupported attempt kinds per provider', async () => {
    const gemini = createFakeProviderAdapter('GEMINI');
    await expect(gemini.submit(baseVideoRequest)).rejects.toThrow('Gemini adapter only supports IMAGE');

    const runway = createFakeProviderAdapter('RUNWAY');
    await expect(runway.submit(baseImageRequest)).rejects.toThrow('Runway adapter only supports VIDEO');
  });
});

describe('LIVE Provider Adapters (PD-05b.3)', () => {
  let tempRoot: string;
  let testStorage: StorageAdapter;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nolen-live-adapters-'));
    testStorage = new StorageAdapter(tempRoot);
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('LiveGeminiImageAdapter handles interleaved text+image output (parts[0]=text, parts[1]=inlineData), binds sha256, and keeps PENDING without realized USD receipt (BLOCK 3)', async () => {
    const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const expectedSha = createHash('sha256').update(pngBytes).digest('hex');

    let submitCount = 0;
    const adapter = new LiveGeminiImageAdapter({
      apiKey: 'test-gemini-key',
      storage: testStorage,
      transportFn: async (url, init) => {
        submitCount++;
        expect(url).toContain('generativelanguage.googleapis.com');
        expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('test-gemini-key');
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'Here is the requested frame with dramatic lighting.' },
                    { inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 1290 },
          }),
          { status: 200, headers: { 'x-goog-request-id': 'req-gem-1' } },
        );
      },
    });

    const attemptId = '11111111-1111-4111-8111-111111111111';
    const sub = await adapter.submit({
      attemptId,
      filmId: '22222222-2222-4222-8222-222222222222',
      kind: 'IMAGE',
      provider: 'GEMINI',
      executionMode: 'LIVE',
      prompt: 'Neon coffee shop',
      aspectRatio: '9:16',
    });

    expect(submitCount).toBe(1);
    expect(sub.providerJobId).toBe(`gemini:${attemptId}:${expectedSha}`);
    expect(sub.provenance).toBe('LIVE_PROVIDER');
    expect(await testStorage.verify('keyframes', `${expectedSha}.png`, expectedSha)).toBe(true);

    // Simulating crash recovery with a fresh adapter instance
    const recoveredAdapter = new LiveGeminiImageAdapter({
      apiKey: 'test-gemini-key',
      storage: testStorage,
    });
    const status = await recoveredAdapter.pollStatus(sub.providerJobId);
    expect(status.state).toBe('SUCCEEDED');
    expect(status.provenance).toBe('LIVE_PROVIDER');
    expect(status.locator).toEqual({
      kind: 'LOCAL_STORAGE',
      category: 'keyframes',
      filename: `${expectedSha}.png`,
      sha256: expectedSha,
    });
    // Usage tokens alone MUST NOT fabricate a USD micros charge
    expect(status.billingEvidence?.status).toBe('PENDING');
  });

  it('LiveRunwayVideoAdapter submits I2V task, polls status, and reports PENDING vs CONFIRMED billing', async () => {
    let calls = 0;
    const adapter = new LiveRunwayVideoAdapter({
      apiKey: 'test-runway-key',
      storage: testStorage,
      transportFn: async (url, init) => {
        calls++;
        if (url.endsWith('/image_to_video')) {
          expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBe('11111111-1111-4111-8111-111111111111');
          return new Response(JSON.stringify({ id: 'rw-task-99' }), { status: 200 });
        }
        if (calls === 2) {
          return new Response(JSON.stringify({ id: 'rw-task-99', status: 'RUNNING' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: 'rw-task-99',
            status: 'SUCCEEDED',
            output: ['https://cdn.runwayml.com/rw-task-99.mp4'],
            billing: { realizedChargeUsdMicros: '250000', evidenceRef: 'rw:inv:99' },
          }),
          { status: 200 },
        );
      },
    });

    const sub = await adapter.submit({
      attemptId: '11111111-1111-4111-8111-111111111111',
      filmId: '22222222-2222-4222-8222-222222222222',
      kind: 'VIDEO',
      provider: 'RUNWAY',
      executionMode: 'LIVE',
      prompt: 'Slow dolly',
      aspectRatio: '9:16',
      keyframeUrl: 'https://example.com/kf.png',
      durationSeconds: 5,
    });
    expect(sub.providerJobId).toBe('rw-task-99');

    const running = await adapter.pollStatus(sub.providerJobId);
    expect(running.state).toBe('RUNNING');

    const succeeded = await adapter.pollStatus(sub.providerJobId);
    expect(succeeded.state).toBe('SUCCEEDED');
    expect(succeeded.mediaUrl).toBe('https://cdn.runwayml.com/rw-task-99.mp4');
    expect(succeeded.billingEvidence).toEqual({
      status: 'CONFIRMED_CHARGED',
      realizedChargeUsdMicros: '250000',
      evidenceRef: 'rw:inv:99',
    });
  });

  it('LiveFalKlingVideoAdapter enforces exact URL.origin whitelist before transmitting FAL_KEY', async () => {
    const sentUrls: string[] = [];
    const adapter = new LiveFalKlingVideoAdapter({
      apiKey: 'secret-fal-key',
      storage: testStorage,
      transportFn: async (url, init) => {
        sentUrls.push(url);
        expect((init?.headers as Record<string, string>).Authorization).toBe('Key secret-fal-key');
        if (url === 'https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video') {
          return new Response(
            JSON.stringify({
              request_id: 'fal-req-1',
              status_url: 'https://queue.fal.run/fal-ai/kling-video/requests/fal-req-1/status',
              response_url: 'https://queue.fal.run/fal-ai/kling-video/requests/fal-req-1',
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/status')) {
          return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ video: { url: 'https://v3.fal.media/files/kling.mp4' } }),
          { status: 200 },
        );
      },
    });

    const sub = await adapter.submit({
      attemptId: '11111111-1111-4111-8111-111111111111',
      filmId: '22222222-2222-4222-8222-222222222222',
      kind: 'VIDEO',
      provider: 'FAL_KLING',
      executionMode: 'LIVE',
      prompt: 'Action pan',
      aspectRatio: '9:16',
      keyframeUrl: 'https://example.com/kf.png',
      durationSeconds: 5,
    });

    const done = await adapter.pollStatus(sub.providerJobId);
    expect(done.state).toBe('SUCCEEDED');
    expect(done.mediaUrl).toBe('https://v3.fal.media/files/kling.mp4');
    expect(sentUrls.length).toBe(3);

    // Unsafe origins (both arbitrary host and suffix-spoofing evil-fal.run / sub.fal.run) MUST fail before sending FAL_KEY
    for (const evilStatusUrl of [
      'https://attacker.com/status',
      'https://evil-fal.run/status',
      'https://evil.queue.fal.run/status',
    ]) {
      let leaked = false;
      const evilAdapter = new LiveFalKlingVideoAdapter({
        apiKey: 'secret-fal-key',
        storage: testStorage,
        transportFn: async url => {
          if (url === evilStatusUrl) leaked = true;
          return new Response(
            JSON.stringify({
              request_id: 'fal-evil',
              status_url: evilStatusUrl,
              response_url: 'https://queue.fal.run/fal-ai/kling-video/requests/fal-evil',
            }),
            { status: 200 },
          );
        },
      });

      await expect(
        evilAdapter.submit({
          attemptId: '11111111-1111-4111-8111-111111111111',
          filmId: '22222222-2222-4222-8222-222222222222',
          kind: 'VIDEO',
          provider: 'FAL_KLING',
          executionMode: 'LIVE',
          prompt: 'Action pan',
          aspectRatio: '9:16',
          keyframeUrl: 'https://example.com/kf.png',
          durationSeconds: 5,
        }),
      ).rejects.toThrow('FAL_UNSAFE_ORIGIN');
      expect(leaked).toBe(false);
    }
  });

  it('BLOCK 1: LiveRunwayVideoAdapter treats HTTP 404 as PENDING/manual reconciliation, never CONFIRMED_UNCHARGED', async () => {
    const adapter = new LiveRunwayVideoAdapter({
      apiKey: 'test-runway-key',
      storage: testStorage,
      transportFn: async () => new Response(JSON.stringify({ error: 'Task not found' }), { status: 404 }),
    });

    const status = await adapter.pollStatus('rw-deleted-404');
    expect(status.state).toBe('FAILED');
    expect(status.billingEvidence).toEqual({
      status: 'PENDING',
      evidenceRef: 'runway:404:rw-deleted-404',
    });

    const rec = await adapter.reconcile('11111111-1111-4111-8111-111111111111', 'rw-deleted-404');
    expect(rec.outcome).toBe('UNRESOLVED_MANUAL_REVIEW');
  });

  it('BLOCK 3: LiveGeminiImageAdapter blocks V2 submit before POST when reference asset is missing or corrupt (0 paid calls)', async () => {
    const refBytes = Buffer.from('reference-image-bytes');
    const refSha = createHash('sha256').update(refBytes).digest('hex');

    let transportCalls = 0;
    const adapter = new LiveGeminiImageAdapter({
      apiKey: 'test-gemini-key',
      storage: testStorage,
      transportFn: async (_url, init) => {
        transportCalls++;
        const body = JSON.parse(String(init?.body)) as { contents: Array<{ parts: unknown[] }> };
        expect(body.contents[0].parts).toHaveLength(2);
        const outPng = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: outPng.toString('base64') } }] } }],
          }),
          { status: 200 },
        );
      },
    });

    const v2ReqWithRef: GenerationRequest = {
      schemaVersion: '2',
      attemptId: '11111111-1111-4111-8111-111111111111',
      filmId: '22222222-2222-4222-8222-222222222222',
      storyRevisionId: '33333333-3333-4333-8333-333333333333',
      shotRevisionId: '44444444-4444-4444-8444-444444444444',
      kind: 'IMAGE',
      provider: 'GEMINI',
      modelId: 'gemini-3.1-flash-image',
      rateCardSnapshotId: '55555555-5555-4555-8555-555555555555',
      executionMode: 'LIVE',
      prompt: 'Hero holding reference bottle',
      negativePrompt: '',
      promptCompilerVersion: 'generation-intent-1',
      shotDependencyHash: 'c'.repeat(64),
      camera: { angle: 'EYE_LEVEL', framing: 'Medium', movement: 'Static' },
      aspectRatio: '9:16',
      inputAssets: [
        {
          source: 'REFERENCE_UPLOAD',
          role: 'CHARACTER_REFERENCE',
          assetId: '66666666-6666-4666-8666-666666666666',
          sha256Hash: refSha,
          mimeType: 'image/png',
        },
      ],
      structuredIntent: {
        shotType: 'CHARACTER',
        authoredPrompt: 'Hero holding reference bottle',
        camera: { angle: 'EYE_LEVEL', framing: 'Medium', movement: 'Static' },
        location: { id: 'loc', name: 'Cafe', description: 'Warm cafe' },
        styleRef: { id: 'style', name: 'Cinema', description: 'Film' },
        subjects: [],
        wardrobes: [],
        props: [],
        continuity: { startLighting: 'Warm', endLighting: 'Warm', startCharacters: [], endCharacters: [] },
        intendedTransitions: [],
      },
    };

    // 1. Missing reference file -> rejects before transport POST (0 paid calls)
    await expect(adapter.submit(v2ReqWithRef)).rejects.toThrow('GEMINI_REFERENCE_ASSET_MISSING');
    expect(transportCalls).toBe(0);

    // 2. Corrupt reference file (hash mismatch) -> rejects before transport POST (0 paid calls)
    await testStorage.write('references', `${refSha}.png`, Buffer.from('corrupt-bytes'));
    await expect(adapter.submit(v2ReqWithRef)).rejects.toThrow('GEMINI_REFERENCE_HASH_MISMATCH');
    expect(transportCalls).toBe(0);

    // 3. Valid reference file -> succeeds and sends 2 parts (text + inlineData)
    await testStorage.write('references', `${refSha}.png`, refBytes);
    const sub = await adapter.submit(v2ReqWithRef);
    expect(sub.state).toBe('SUBMITTED');
    expect(transportCalls).toBe(1);
  });
});

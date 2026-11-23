import { describe, it, expect } from 'vitest';
import { createProviderAdapter, createFakeProviderAdapter } from './index.js';
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
    expect(status.mediaUrl).toContain('gemini-mock-keyframe.png');

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
    expect(status.mediaUrl).toContain('runway-mock-video.mp4');
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
    expect(status.mediaUrl).toContain('fal-kling-mock-video.mp4');
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
    expect(() => createProviderAdapter('GEMINI', 'LIVE')).toThrow('LIVE_PROVIDER_UNAVAILABLE');
    expect(() => createProviderAdapter('RUNWAY', 'LIVE')).toThrow('LIVE_PROVIDER_UNAVAILABLE');
    expect(() => createProviderAdapter('FAL_KLING', 'LIVE')).toThrow('LIVE_PROVIDER_UNAVAILABLE');
  });

  it('rejects unsupported attempt kinds per provider', async () => {
    const gemini = createFakeProviderAdapter('GEMINI');
    await expect(gemini.submit(baseVideoRequest)).rejects.toThrow('Gemini adapter only supports IMAGE');

    const runway = createFakeProviderAdapter('RUNWAY');
    await expect(runway.submit(baseImageRequest)).rejects.toThrow('Runway adapter only supports VIDEO');
  });
});

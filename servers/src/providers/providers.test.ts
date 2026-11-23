import { describe, it, expect } from 'vitest';
import { createProviderAdapter } from './index.js';
import type { GenerationRequest } from '@nolen/contracts';

describe('Provider Adapters (PD-02)', () => {
  const baseImageRequest: GenerationRequest = {
    attemptId: '11111111-1111-4111-8111-111111111111',
    filmId: '22222222-2222-4222-8222-222222222222',
    kind: 'IMAGE',
    provider: 'GEMINI',
    prompt: 'A cyberpunk ramen stall in rainy Neo-Seoul',
    aspectRatio: '9:16',
  };

  const baseVideoRequest: GenerationRequest = {
    attemptId: '33333333-3333-4333-8333-333333333333',
    filmId: '22222222-2222-4222-8222-222222222222',
    kind: 'VIDEO',
    provider: 'RUNWAY',
    prompt: 'Slow dolly zoom into character eyes',
    aspectRatio: '9:16',
    keyframeAssetId: '44444444-4444-4444-8444-444444444444',
  };

  it('submits and polls Fake Gemini adapter', async () => {
    const adapter = createProviderAdapter('GEMINI');
    expect(adapter.kind).toBe('GEMINI');

    const result = await adapter.submit(baseImageRequest);
    expect(result.state).toBe('SUBMITTED');
    expect(result.providerJobId).toBe(`gemini-${baseImageRequest.attemptId}`);

    const status = await adapter.pollStatus(result.providerJobId);
    expect(status.state).toBe('SUCCEEDED');
    expect(status.mediaUrl).toContain('gemini-mock-keyframe.png');

    const reconciliation = await adapter.reconcile(baseImageRequest.attemptId, result.providerJobId);
    expect(reconciliation.outcome).toBe('CONFIRMED_SUCCEEDED');
  });

  it('submits and polls Fake Runway adapter', async () => {
    const adapter = createProviderAdapter('RUNWAY');
    expect(adapter.kind).toBe('RUNWAY');

    const result = await adapter.submit(baseVideoRequest);
    expect(result.state).toBe('SUBMITTED');
    expect(result.providerJobId).toBe(`runway-task-${baseVideoRequest.attemptId}`);

    const status = await adapter.pollStatus(result.providerJobId);
    expect(status.state).toBe('SUCCEEDED');
    expect(status.mediaUrl).toContain('runway-mock-video.mp4');
  });

  it('submits and polls Fake fal.ai Kling adapter', async () => {
    const adapter = createProviderAdapter('FAL_KLING');
    expect(adapter.kind).toBe('FAL_KLING');

    const result = await adapter.submit({ ...baseVideoRequest, provider: 'FAL_KLING' });
    expect(result.state).toBe('SUBMITTED');

    const status = await adapter.pollStatus(result.providerJobId);
    expect(status.state).toBe('SUCCEEDED');
    expect(status.mediaUrl).toContain('fal-kling-mock-video.mp4');
  });

  it('handles LocalPanZoom adapter deterministically', async () => {
    const adapter = createProviderAdapter('LOCAL_PAN_ZOOM');
    expect(adapter.kind).toBe('LOCAL_PAN_ZOOM');

    const result = await adapter.submit({ ...baseVideoRequest, provider: 'LOCAL_PAN_ZOOM' });
    expect(result.state).toBe('SUCCEEDED');

    const status = await adapter.pollStatus(result.providerJobId);
    expect(status.state).toBe('SUCCEEDED');
  });

  it('rejects unsupported attempt kinds per provider', async () => {
    const gemini = createProviderAdapter('GEMINI');
    await expect(gemini.submit(baseVideoRequest)).rejects.toThrow('Gemini adapter only supports IMAGE');

    const runway = createProviderAdapter('RUNWAY');
    await expect(runway.submit(baseImageRequest)).rejects.toThrow('Runway adapter only supports VIDEO');
  });
});

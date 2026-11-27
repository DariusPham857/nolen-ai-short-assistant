import type { ProviderKind, ExecutionMode } from '@nolen/contracts';
import type { ProviderAdapter } from './adapter.js';
import { FakeGeminiAdapter } from './gemini.js';
import { FakeRunwayAdapter } from './runway.js';
import { FakeFalKlingAdapter } from './fal-kling.js';
import { LocalPanZoomAdapter } from './local-pan-zoom.js';
import { LiveGeminiImageAdapter, type LiveGeminiAdapterOptions } from './gemini-image.js';
import { LiveRunwayVideoAdapter, type LiveRunwayAdapterOptions } from './runway-video.js';
import { LiveFalKlingVideoAdapter, type LiveFalKlingAdapterOptions } from './fal-kling-video.js';

export * from './adapter.js';
export * from './gemini.js';
export * from './runway.js';
export * from './fal-kling.js';
export * from './local-pan-zoom.js';
export * from './gemini-image.js';
export * from './runway-video.js';
export * from './fal-kling-video.js';

export type LiveProviderAdapterOptions = LiveGeminiAdapterOptions & LiveRunwayAdapterOptions & LiveFalKlingAdapterOptions;

/**
 * Dedicated factory for fake/fixture adapters (REPLAY mode only).
 * Guaranteed to return fixture provenance and never touch external networks.
 */
export function createFakeProviderAdapter(kind: ProviderKind): ProviderAdapter {
  switch (kind) {
    case 'GEMINI':
      return new FakeGeminiAdapter();
    case 'RUNWAY':
      return new FakeRunwayAdapter();
    case 'FAL_KLING':
      return new FakeFalKlingAdapter();
    case 'LOCAL_PAN_ZOOM':
      return new LocalPanZoomAdapter();
    default: {
      const exhaustiveCheck: never = kind;
      throw new Error(`Unsupported provider kind: ${String(exhaustiveCheck)}`);
    }
  }
}

/**
 * Primary provider adapter factory with strict execution mode enforcement.
 * Fails closed if credentials are absent or if a fake transport is requested in LIVE mode.
 */
export function createProviderAdapter(
  kind: ProviderKind,
  mode: ExecutionMode = 'REPLAY',
  options?: LiveProviderAdapterOptions,
): ProviderAdapter {
  if (mode === 'LIVE') {
    switch (kind) {
      case 'LOCAL_PAN_ZOOM':
        return new LocalPanZoomAdapter('LIVE');
      case 'GEMINI':
        return new LiveGeminiImageAdapter(options);
      case 'RUNWAY':
        return new LiveRunwayVideoAdapter(options);
      case 'FAL_KLING':
        return new LiveFalKlingVideoAdapter(options);
      default: {
        const exhaustiveCheck: never = kind;
        throw new Error(`Unsupported provider kind: ${String(exhaustiveCheck)}`);
      }
    }
  }

  return createFakeProviderAdapter(kind);
}

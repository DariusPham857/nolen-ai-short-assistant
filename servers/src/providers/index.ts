import type { ProviderKind, ExecutionMode } from '@nolen/contracts';
import type { ProviderAdapter } from './adapter.js';
import { FakeGeminiAdapter } from './gemini.js';
import { FakeRunwayAdapter } from './runway.js';
import { FakeFalKlingAdapter } from './fal-kling.js';
import { LocalPanZoomAdapter } from './local-pan-zoom.js';

export * from './adapter.js';
export * from './gemini.js';
export * from './runway.js';
export * from './fal-kling.js';
export * from './local-pan-zoom.js';

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
 * Fails closed if a fake transport is requested in LIVE mode.
 */
export function createProviderAdapter(kind: ProviderKind, mode: ExecutionMode = 'REPLAY'): ProviderAdapter {
  if (mode === 'LIVE') {
    // Fail closed: real live provider integrations for G3 must be explicitly configured
    throw new Error(
      `LIVE_PROVIDER_UNAVAILABLE: Real provider transport for ${kind} is not configured; fake transport is strictly forbidden in LIVE mode`,
    );
  }

  return createFakeProviderAdapter(kind);
}

import type { ProviderKind } from '@nolen/contracts';
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

export function createProviderAdapter(kind: ProviderKind): ProviderAdapter {
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

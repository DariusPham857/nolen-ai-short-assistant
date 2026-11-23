import { Hono } from 'hono';
import { reviewAssetSchema } from '@nolen/contracts';
import { getAssetMedia, getShotAssets, reviewAsset } from '../assets/repository.js';
import { ApiFailure } from './errors.js';
import { boundedJson, installBoundary, requireOperator, resourceId } from './boundary.js';

export function createAssetApi() {
  const api = new Hono();
  installBoundary(api);

  api.get('/api/films/:filmId/shots/:shotId/assets', async c => {
    const filmId = resourceId(c.req.param('filmId'));
    const shotId = resourceId(c.req.param('shotId'));
    const operatorId = await requireOperator(c);
    const result = await getShotAssets(filmId, shotId, operatorId);
    return c.json(result);
  });

  api.post('/api/assets/:assetId/review', async c => {
    const assetId = resourceId(c.req.param('assetId'));
    const operatorId = await requireOperator(c);
    const body = reviewAssetSchema.parse(await boundedJson(c.req.raw, 16384));
    const result = await reviewAsset(assetId, operatorId, body);
    return c.json(result);
  });

  api.get('/api/assets/:assetId/media', async c => {
    const assetId = resourceId(c.req.param('assetId'));
    const operatorId = await requireOperator(c);
    const { buffer, mimeType, byteSize, sha256 } = await getAssetMedia(assetId, operatorId);
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': byteSize,
        'ETag': `"${sha256}"`,
        'Cache-Control': 'private, max-age=86400',
      },
    });
  });

  for (const [route, allow] of [
    ['/api/films/:filmId/shots/:shotId/assets', 'GET'],
    ['/api/assets/:assetId/review', 'POST'],
    ['/api/assets/:assetId/media', 'GET'],
  ] as const) {
    api.all(route, c => {
      c.header('Allow', allow);
      throw new ApiFailure(405, 'METHOD_NOT_ALLOWED', 'Method not supported');
    });
  }

  return api;
}

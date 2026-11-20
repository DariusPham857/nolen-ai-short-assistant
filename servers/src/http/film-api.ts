import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { normalizeFilm } from '@nolen/contracts';
import { APP_ORIGIN } from '../config/runtime.js';
import { COOKIE, SESSION_SECONDS, authenticate, revoke, unlock } from '../auth/sessions.js';
import { createFilm, getFilm, IdempotencyConflict } from '../films/repository.js';
import { ApiFailure, failure } from './errors.js';

const keySchema = z.string().uuid().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

/** Stream-bound JSON parser, including chunked bodies with absent/lying Content-Length. */
async function boundedJson(request: Request, limit: number): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiFailure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json');
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new ApiFailure(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds limit'); }
      chunks.push(next.value);
    }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new ApiFailure(400, 'INVALID_JSON', 'Malformed JSON'); }
}

/** Single-process localhost limiter; one bounded bucket, reset on web restart. */
export function createFilmApi() {
  const api = new Hono();
  let windowStart = 0;
  let attempts = 0;
  api.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if ((c.req.header('host') ?? new URL(c.req.url).host) !== '127.0.0.1:3000') {
      return failure(c, 403, 'HOST_REJECTED', 'Unsupported host');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('origin') !== APP_ORIGIN) {
      return failure(c, 403, 'ORIGIN_REJECTED', 'Unsupported or missing origin');
    }
    await next();
  });

  api.post('/api/operator/session', async c => {
    const now = Date.now();
    if (now - windowStart >= 60000) { windowStart = now; attempts = 0; }
    if (++attempts > 5) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((windowStart + 60000 - now) / 1000))));
      return failure(c, 429, 'RATE_LIMITED', 'Too many unlock attempts');
    }
    const body = z.object({ token: z.string().max(2048) }).strict().parse(await boundedJson(c.req.raw, 4096));
    const id = await unlock(body.token);
    if (!id) return failure(c, 401, 'UNAUTHORIZED', 'Invalid operator token');
    setCookie(c, COOKIE, id, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: SESSION_SECONDS, secure: new URL(APP_ORIGIN).protocol === 'https:' });
    return c.body(null, 204);
  });
  api.delete('/api/operator/session', async c => {
    await revoke(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: '/' });
    return c.body(null, 204);
  });
  api.post('/api/films', async c => {
    const operator = await authenticate(getCookie(c, COOKIE));
    if (!operator) return failure(c, 401, 'UNAUTHORIZED', 'Unlock the local workspace');
    const key = keySchema.safeParse(c.req.header('Idempotency-Key'));
    if (!key.success) return failure(c, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Use a UUID-v4 Idempotency-Key');
    const input = normalizeFilm(await boundedJson(c.req.raw, 65536));
    const film = await createFilm(input, key.data, operator);
    c.header('Location', `/api/films/${film.id}`);
    return c.json(film, 201);
  });
  api.get('/api/films/:id', async c => {
    const operator = await authenticate(getCookie(c, COOKIE));
    if (!operator) return failure(c, 401, 'UNAUTHORIZED', 'Unlock the local workspace');
    const id = z.string().uuid().safeParse(c.req.param('id'));
    if (!id.success) return failure(c, 400, 'INVALID_ID', 'Invalid Film ID');
    const film = await getFilm(id.data, operator);
    return film ? c.json(film) : failure(c, 404, 'FILM_NOT_FOUND', 'Film not found');
  });
  for (const [route, allow] of [['/api/operator/session', 'POST, DELETE'], ['/api/films', 'POST'], ['/api/films/:id', 'GET']]) {
    api.all(route, c => { c.header('Allow', allow); return failure(c, 405, 'METHOD_NOT_ALLOWED', 'Method not supported'); });
  }
  api.onError((error, c) => {
    if (error instanceof ApiFailure) return failure(c, error.status, error.code, error.message, error.details);
    if (error instanceof z.ZodError) return failure(c, 422, 'VALIDATION_ERROR', 'Check the submitted fields', error.flatten().fieldErrors);
    if (error instanceof IdempotencyConflict) return failure(c, 409, 'IDEMPOTENCY_CONFLICT', 'Key was already used for different content');
    // postgres/drizzle exceptions can contain SQL and credentials; never serialize them.
    console.error('[film-api] request failed');
    if (isDatabaseFailure(error)) return failure(c, 503, 'DATABASE_UNAVAILABLE', 'Storage is temporarily unavailable');
    return failure(c, 500, 'INTERNAL_ERROR', 'Request failed');
  });
  return api;
}

/** Drizzle wraps driver errors in cause; recognize DB/network failures without exposing details. */
function isDatabaseFailure(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 4) return false;
  if ('code' in error && typeof error.code === 'string' && (/^[0-9A-Z]{5}$/.test(error.code) || /^(ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|CONNECTION_|CONNECT_)/.test(error.code))) return true;
  return 'cause' in error && isDatabaseFailure(error.cause, depth + 1);
}

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { normalizeFilm } from '@nolen/contracts';
import { boundedJson, installBoundary, keySchema, requireOperator } from './boundary.js';
import { APP_ORIGIN } from '../config/runtime.js';
import { COOKIE, SESSION_SECONDS, revoke, unlock } from '../auth/sessions.js';
import { createFilm, getFilm } from '../films/repository.js';
import { failure } from './errors.js';

/** Single-process localhost limiter; one bounded bucket, reset on web restart. */
export function createFilmApi() {
  const api = new Hono();
  let windowStart = 0;
  let attempts = 0;
  installBoundary(api);
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
    const operator = await requireOperator(c);
    const key = keySchema.safeParse(c.req.header('Idempotency-Key'));
    if (!key.success) return failure(c, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Use a UUID-v4 Idempotency-Key');
    const input = normalizeFilm(await boundedJson(c.req.raw, 65536));
    const film = await createFilm(input, key.data, operator);
    c.header('Location', `/api/films/${film.id}`);
    return c.json(film, 201);
  });
  api.get('/api/films/:id', async c => {
    const operator = await requireOperator(c);
    const id = z.string().uuid().safeParse(c.req.param('id'));
    if (!id.success) return failure(c, 400, 'INVALID_ID', 'Invalid Film ID');
    const film = await getFilm(id.data, operator);
    return film ? c.json(film) : failure(c, 404, 'FILM_NOT_FOUND', 'Film not found');
  });
  for (const [route, allow] of [['/api/operator/session', 'POST, DELETE'], ['/api/films', 'POST'], ['/api/films/:id', 'GET']]) {
    api.all(route, c => { c.header('Allow', allow); return failure(c, 405, 'METHOD_NOT_ALLOWED', 'Method not supported'); });
  }
  return api;
}

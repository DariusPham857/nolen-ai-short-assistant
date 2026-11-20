import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { normalizeFilm, filmDtoSchema, apiErrorSchema } from '@nolen/contracts';
import { createFilmApi } from '../http/film-api.js';
import { db, pgClient } from '../db/index.js';
import { films } from '../db/schema/films.js';
import { operatorSessions } from '../db/schema/sessions.js';
import { authenticate, digest, revoke, unlock } from '../auth/sessions.js';
import { migrateDatabase } from '../db/migrate.js';

const token = 'test-only-operator-token-32-bytes-minimum';
const input = normalizeFilm({ title: ' Test ', brief: ' Brief ', budgetLimitUsdMicros: '9223372036854775807', durationTargetSeconds: 30, aspectRatio: '9:16' });
let cookie: string;
const api = createFilmApi();
/** Real API invocation over real PG16, without network or financial/provider mocks. */
function request(route: string, method = 'GET', body?: unknown, key = randomUUID(), headers: Record<string,string> = {}) {
  return api.request(`http://127.0.0.1:3000${route}`, { method, headers: {
    Origin: 'http://127.0.0.1:3000', Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

beforeAll(async () => {
  process.env.OPERATOR_TOKEN = token;
  await migrateDatabase(process.env.DATABASE_URL!);
  const id = await unlock(token);
  cookie = `nolen_session=${id}`;
});
afterAll(async () => { await pgClient.end(); });

it('20 simultaneous creates commit one Film; normalized replay, conflict and read', async () => {
  const key = randomUUID();
  const responses = await Promise.all(Array.from({ length: 20 }, () => request('/api/films', 'POST', input, key)));
  expect(responses.map(r => r.status)).toEqual(Array(20).fill(201));
  const bodies = await Promise.all(responses.map(async r => filmDtoSchema.parse(await r.json())));
  expect(new Set(bodies.map(b => b.id)).size).toBe(1);
  expect(new Set(responses.map(r => r.headers.get('Location')))).toEqual(new Set([`/api/films/${bodies[0].id}`]));
  expect(bodies[0].budgetLimitUsdMicros).toBe(input.budgetLimitUsdMicros);
  expect(bodies[0].status).toBe('DRAFT');
  expect(bodies[0].activeStoryRevisionId).toBeNull();
  expect(await db.select().from(films).where(eq(films.idempotencyKey, key))).toHaveLength(1);
  expect((await request('/api/films', 'POST', { ...input, title: 'Test ', styleNotes: '  ' }, key)).status).toBe(201);
  expect((await request('/api/films', 'POST', { ...input, title: 'Other' }, key)).status).toBe(409);
  const read = await request(`/api/films/${bodies[0].id}`);
  expect(read.status).toBe(200);
  expect(read.headers.get('cache-control')).toBe('no-store');
  expect(filmDtoSchema.parse(await read.json())).toEqual(bodies[0]);
});

it('zero accepted, numeric money/invalid input rejected; no partial insert', async () => {
  expect((await request('/api/films', 'POST', { ...input, budgetLimitUsdMicros: '0' })).status).toBe(201);
  const key = randomUUID();
  expect((await request('/api/films', 'POST', { ...input, budgetLimitUsdMicros: 1 }, key)).status).toBe(422);
  expect(await db.select().from(films).where(eq(films.idempotencyKey, key))).toHaveLength(0);
  expect((await request(`/api/films/${randomUUID()}`)).status).toBe(404);
  expect((await request('/api/films/not-uuid')).status).toBe(400);
});

it('Host/Origin/media/method/bounds failures cannot mutate state', async () => {
  const key = randomUUID();
  const rejected: Record<string,string>[] = [{Host:'evil.test'}, {Origin:'http://localhost:3000'}, {Origin:''}];
  for (const headers of rejected) {
    expect((await request('/api/films', 'POST', input, key, headers)).status).toBe(403);
  }
  expect(await db.select().from(films).where(eq(films.idempotencyKey, key))).toHaveLength(0);
  expect((await request('/api/films', 'POST', input, key, {'Content-Type':'text/plain'})).status).toBe(415);
  const oversized = await request('/api/films', 'POST', { ...input, brief: 'x'.repeat(65537) });
  expect(oversized.status).toBe(413);
  const method = await request('/api/films', 'PUT');
  expect(method.status).toBe(405);
  expect(method.headers.get('allow')).toBe('POST');
});

it('unlock/logout revokes a copied cookie across new app instances', async () => {
  const response = await request('/api/operator/session', 'POST', {token});
  expect(response.status).toBe(204);
  const sessionCookie = response.headers.get('set-cookie')!;
  expect(sessionCookie).toContain('HttpOnly');
  expect(sessionCookie).toContain('SameSite=Strict');
  expect(sessionCookie).not.toContain('Domain=');
  const copied = sessionCookie.split(';')[0];
  expect((await request('/api/operator/session', 'DELETE', undefined, randomUUID(), {Cookie:copied})).status).toBe(204);
  const restarted = createFilmApi();
  expect((await restarted.request(`http://127.0.0.1:3000/api/films/${randomUUID()}`, {headers:{Cookie:copied}})).status).toBe(401);
});

it('session expiry and token rotation invalidate rows without deleting them', async () => {
  const id = (await unlock(token))!;
  expect(await authenticate(id)).toBe('local-operator');
  process.env.OPERATOR_TOKEN = token + '-rotated';
  expect(await authenticate(id)).toBeNull();
  process.env.OPERATOR_TOKEN = token;
  await db.update(operatorSessions).set({expiresAt:new Date(0)}).where(eq(operatorSessions.sessionHash,digest(id)));
  expect(await authenticate(id)).toBeNull();
  await revoke(id);
});

it('session lookup database errors are 503, malformed/no cookie is 401', async () => {
  const route = `/api/films/${randomUUID()}`;
  expect((await request(route,'GET',undefined,randomUUID(),{Cookie:''})).status).toBe(401);
  // Temporarily rename the session table inside test-only DDL; restore even on assertion failure.
  await db.execute(sql`ALTER TABLE operator_sessions RENAME TO operator_sessions_unavailable`);
  try {
    const response = await request(route);
    expect(response.status).toBe(503);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('DATABASE_UNAVAILABLE');
  } finally { await db.execute(sql`ALTER TABLE operator_sessions_unavailable RENAME TO operator_sessions`); }
});

it('rate limits the sixth unlock attempt with Retry-After', async () => {
  const limited = createFilmApi();
  for (let i=0;i<5;i++) {
    expect((await limited.request('http://127.0.0.1:3000/api/operator/session',{method:'POST',headers:{Origin:'http://127.0.0.1:3000','Content-Type':'application/json'},body:'{"token":"wrong"}'})).status).toBe(401);
  }
  const response=await limited.request('http://127.0.0.1:3000/api/operator/session',{method:'POST',headers:{Origin:'http://127.0.0.1:3000'}});
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBeTruthy();
});

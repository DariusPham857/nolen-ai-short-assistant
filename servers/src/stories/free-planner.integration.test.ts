import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { canonicalStoryV2, normalizeFilm, type Expected, type Storyboard } from '@nolen/contracts';
import { createStoryApi } from '../http/story-api.js';
import { createFilm } from '../films/repository.js';
import { pgClient, db } from '../db/index.js';
import { films } from '../db/schema/films.js';
import { migrateDatabase } from '../db/migrate.js';
import { unlock } from '../auth/sessions.js';

const token = 'test-only-operator-token-32-bytes-minimum';
let cookie: string;

const baseInput = normalizeFilm({
  title: 'Free Planner PG16 Test',
  brief: 'A quiet studio lamp story',
  budgetLimitUsdMicros: '10000000',
  durationTargetSeconds: 45,
  aspectRatio: '9:16',
});

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function requestWithApi(
  api: ReturnType<typeof createStoryApi>,
  filmId: string,
  route: string,
  body?: unknown,
  key: string | null = randomUUID(),
) {
  return api.request(`http://127.0.0.1:3000/api/films/${filmId}/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Cookie: cookie,
      Origin: 'http://127.0.0.1:3000',
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  process.env.OPERATOR_TOKEN = token;
  await migrateDatabase(process.env.DATABASE_URL!);
  cookie = `nolen_session=${await unlock(token)}`;
});

afterAll(async () => {
  await pgClient.end();
});

it('verifies ownership, stale token, mid-flight barriers (story/brief/duration/delete), and zero domain writes (FP-AT-04)', async () => {
  const film = await createFilm(baseInput, randomUUID(), 'local-operator');
  const otherFilm = await createFilm(baseInput, randomUUID(), 'other-operator');

  const proposalPayload = {
    provenance: { source: 'LIVE_LLM' as const, model: 'gemini-3.5-flash-lite', liveInference: true as const },
    content: canonicalStoryV2(),
    findings: [],
  };

  // 1. Non-owner rejected before generator runs
  const spyUnowned = vi.fn(async () => proposalPayload);
  const apiUnowned = createStoryApi({ generateGeminiProposal: spyUnowned });
  const unownedRes = await requestWithApi(apiUnowned, otherFilm.id, 'storyboard/plan-proposals', {
    expectedStoryRevisionId: null,
    expectedStateVersion: 0,
    mode: 'GEMINI_FREE_PLANNER',
  }, null);
  expect(unownedRes.status).toBe(404);
  expect(spyUnowned).not.toHaveBeenCalled();

  // 2. Stale token rejected before generator runs
  const staleRes = await requestWithApi(apiUnowned, film.id, 'storyboard/plan-proposals', {
    expectedStoryRevisionId: randomUUID(),
    expectedStateVersion: 0,
    mode: 'GEMINI_FREE_PLANNER',
  }, null);
  expect(staleRes.status).toBe(409);
  expect(spyUnowned).not.toHaveBeenCalled();

  // 3. Happy path returns 200 and leaves zero domain writes
  const happyRes = await requestWithApi(apiUnowned, film.id, 'storyboard/plan-proposals', {
    expectedStoryRevisionId: null,
    expectedStateVersion: 0,
    mode: 'GEMINI_FREE_PLANNER',
  }, null);
  expect(happyRes.status).toBe(200);
  expect(spyUnowned).toHaveBeenCalledTimes(1);

  const [revCount] = await pgClient<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM story_revisions WHERE film_id = ${film.id}`;
  const [attCount] = await pgClient<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM attempts WHERE film_id = ${film.id}`;
  const [ledCount] = await pgClient<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM cost_ledger_events WHERE film_id = ${film.id}`;
  expect(Number(revCount.c)).toBe(0);
  expect(Number(attCount.c)).toBe(0);
  expect(Number(ledCount.c)).toBe(0);

  // 4. Mid-flight brief/duration change -> 409 VERSION_CONFLICT
  const enteredBrief = createDeferred();
  const releaseBrief = createDeferred();
  const apiBrief = createStoryApi({
    generateGeminiProposal: async () => {
      enteredBrief.resolve();
      await releaseBrief.promise;
      return proposalPayload;
    },
  });
  const pendingBrief = requestWithApi(apiBrief, film.id, 'storyboard/plan-proposals', {
    expectedStoryRevisionId: null,
    expectedStateVersion: 0,
    mode: 'GEMINI_FREE_PLANNER',
  }, null);
  await enteredBrief.promise;
  await pgClient`UPDATE films SET brief = 'Changed brief mid-flight', duration_target_seconds = 60 WHERE id = ${film.id}`;
  releaseBrief.resolve();
  const briefConflict = await pendingBrief;
  expect(briefConflict.status).toBe(409);

  // 5. Mid-flight story revision saved -> 409 VERSION_CONFLICT
  const enteredStory = createDeferred();
  const releaseStory = createDeferred();
  const apiStory = createStoryApi({
    generateGeminiProposal: async () => {
      enteredStory.resolve();
      await releaseStory.promise;
      return proposalPayload;
    },
  });
  const pendingStory = requestWithApi(apiStory, film.id, 'storyboard/plan-proposals', {
    expectedStoryRevisionId: null,
    expectedStateVersion: 0,
    mode: 'GEMINI_FREE_PLANNER',
  }, null);
  await enteredStory.promise;
  const saveRes = await requestWithApi(apiStory, film.id, 'storyboard/revisions', {
    expectedStoryRevisionId: null,
    expectedStateVersion: 0,
    content: canonicalStoryV2(),
  });
  expect(saveRes.status).toBe(201);
  releaseStory.resolve();
  const storyConflict = await pendingStory;
  expect(storyConflict.status).toBe(409);

  // 6. Mid-flight film deleted -> 404 FILM_NOT_FOUND (bare film row without append-only budget_limit_events)
  const [tempFilm] = await db.insert(films).values({
    ...baseInput,
    budgetLimitUsdMicros: BigInt(baseInput.budgetLimitUsdMicros),
    operatorId: 'local-operator',
    idempotencyKey: randomUUID(),
    requestHash: '0'.repeat(64),
  }).returning();
  const enteredDelete = createDeferred();
  const releaseDelete = createDeferred();
  const apiDelete = createStoryApi({
    generateGeminiProposal: async () => {
      enteredDelete.resolve();
      await releaseDelete.promise;
      return proposalPayload;
    },
  });
  const pendingDelete = requestWithApi(apiDelete, tempFilm.id, 'storyboard/plan-proposals', {
    expectedStoryRevisionId: null,
    expectedStateVersion: 0,
    mode: 'GEMINI_FREE_PLANNER',
  }, null);
  await enteredDelete.promise;
  await pgClient`DELETE FROM films WHERE id = ${tempFilm.id}`;
  releaseDelete.resolve();
  const deleteRes = await pendingDelete;
  expect(deleteRes.status).toBe(404);
});

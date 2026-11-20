import { expect, it, vi } from 'vitest';
import { createFilmApi } from './film-api.js';
const { authenticate }=vi.hoisted(()=>({authenticate:vi.fn()}));
vi.mock('../auth/sessions.js',()=>({COOKIE:'nolen_session',SESSION_SECONDS:28800,authenticate,unlock:vi.fn(),revoke:vi.fn()}));

it('postgres-js network timeout during session lookup is 503, never 401 or success',async()=>{
  authenticate.mockRejectedValue(Object.assign(new Error('private connection details'),{code:'CONNECT_TIMEOUT'}));
  const response=await createFilmApi().request('http://127.0.0.1:3000/api/films/00000000-0000-4000-8000-000000000001');
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private connection details');
});

it('unclassified exceptions have safe 500 rather than a false DB/auth diagnosis',async()=>{
  authenticate.mockRejectedValue(new Error('internal detail'));
  const response=await createFilmApi().request('http://127.0.0.1:3000/api/films/00000000-0000-4000-8000-000000000001');
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('internal detail');
});

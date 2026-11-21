import { Hono } from 'hono';
import { createAttemptSchema, estimateAttemptSchema, reconcileAttemptSchema, updateBudgetSchema } from '@nolen/contracts';
import { admitAttempt, changeBudget, estimateAttempt, readAttemptFinancial, readBudget, readLedger, readSummary, reconcileAttempt } from '../financial/repository.js';
import { ApiFailure } from './errors.js';
import { boundedJson, installBoundary, keySchema, requireOperator, resourceId } from './boundary.js';

function requiredKey(value:string|undefined):string {
  const parsed=keySchema.safeParse(value);
  if(!parsed.success)throw new ApiFailure(400,'IDEMPOTENCY_KEY_REQUIRED','Use a UUID-v4 Idempotency-Key');
  return parsed.data;
}

/** Financial Core routes share the FC/SP security and error boundary. */
export function createFinancialApi(){
  const api=new Hono();installBoundary(api);
  api.get('/api/films/:filmId/budget',async c=>c.json(await readBudget(resourceId(c.req.param('filmId')),await requireOperator(c))));
  api.post('/api/films/:filmId/budget/estimate',async c=>c.json(await estimateAttempt(resourceId(c.req.param('filmId')),await requireOperator(c),estimateAttemptSchema.parse(await boundedJson(c.req.raw,16384)))));
  api.patch('/api/films/:filmId/budget',async c=>c.json(await changeBudget(resourceId(c.req.param('filmId')),await requireOperator(c),requiredKey(c.req.header('Idempotency-Key')),updateBudgetSchema.parse(await boundedJson(c.req.raw,16384)))));
  api.post('/api/films/:filmId/attempts',async c=>c.json(await admitAttempt(resourceId(c.req.param('filmId')),await requireOperator(c),requiredKey(c.req.header('Idempotency-Key')),createAttemptSchema.parse(await boundedJson(c.req.raw,16384))),201));
  api.get('/api/films/:filmId/costs/ledger',async c=>c.json(await readLedger(resourceId(c.req.param('filmId')),await requireOperator(c))));
  api.get('/api/films/:filmId/costs/summary',async c=>c.json(await readSummary(resourceId(c.req.param('filmId')),await requireOperator(c))));
  api.get('/api/attempts/:attemptId/financials',async c=>c.json(await readAttemptFinancial(resourceId(c.req.param('attemptId')),await requireOperator(c))));
  api.post('/api/attempts/:attemptId/reconcile',async c=>c.json(await reconcileAttempt(resourceId(c.req.param('attemptId')),await requireOperator(c),requiredKey(c.req.header('Idempotency-Key')),reconcileAttemptSchema.parse(await boundedJson(c.req.raw,16384)))));
  for(const [route,allow] of [
    ['/api/films/:filmId/budget','GET, PATCH'],['/api/films/:filmId/budget/estimate','POST'],['/api/films/:filmId/attempts','POST'],
    ['/api/films/:filmId/costs/ledger','GET'],['/api/films/:filmId/costs/summary','GET'],['/api/attempts/:attemptId/financials','GET'],['/api/attempts/:attemptId/reconcile','POST'],
  ] as const)api.all(route,c=>{c.header('Allow',allow);throw new ApiFailure(405,'METHOD_NOT_ALLOWED','Method not supported');});
  return api;
}


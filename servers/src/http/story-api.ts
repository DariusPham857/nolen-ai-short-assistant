import { Hono } from 'hono';
import { canonicalStory, expectedSchema, saveStorySchema, validateStorySchema, waiverSchema } from '@nolen/contracts';
import { pgClient } from '../db/index.js';
import { command, readStoryboard } from '../stories/repository.js';
import { ApiFailure } from './errors.js';
import { boundedJson, installBoundary, keySchema, requireOperator, resourceId } from './boundary.js';

/** Story routes use the same security boundary as Film, including standalone Hono invocation. */
export function createStoryApi(){
  const api=new Hono();installBoundary(api);
  api.get('/api/films/:filmId/storyboard',async c=>{const operator=await requireOperator(c);return c.json(await readStoryboard(resourceId(c.req.param('filmId')),operator));});
  api.get('/api/films/:filmId/storyboard/revisions/:revisionId',async c=>{const operator=await requireOperator(c);return c.json(await readStoryboard(resourceId(c.req.param('filmId')),operator,resourceId(c.req.param('revisionId'))));});
  for(const kind of ['revisions','mark-planned','submit-review','approve','waivers','plan-proposals','validate'] as const){
    const route=kind==='validate'?'/api/films/:filmId/continuity/validate':`/api/films/:filmId/storyboard/${kind}`;
    api.post(route,async c=>{
      const operator=await requireOperator(c);const filmId=resourceId(c.req.param('filmId'));
      const body=await boundedJson(c.req.raw,524288);
      if(kind==='plan-proposals'){
        expectedSchema.parse(body);
        const [film]=await pgClient`SELECT id FROM films WHERE id=${filmId} AND operator_id=${operator}`;
        if(!film)throw new ApiFailure(404,'FILM_NOT_FOUND','Film not found');
        return c.json({provenance:{source:'FIXTURE',fixtureId:'the-last-light-45s-v1',liveInference:false},content:canonicalStory()});
      }
      if(kind==='validate'){
        const input=validateStorySchema.parse(body);
        if(input.context!=='STORY_APPROVAL')throw new ApiFailure(422,'VALIDATION_CONTEXT_NOT_IMPLEMENTED','VIDEO_DISPATCH is not implemented');
        return c.json(await command(filmId,operator,null,'validate',expectedSchema.parse({expectedStoryRevisionId:input.expectedStoryRevisionId,expectedStateVersion:input.expectedStateVersion})));
      }
      const key=keySchema.safeParse(c.req.header('Idempotency-Key'));
      if(!key.success)throw new ApiFailure(400,'IDEMPOTENCY_KEY_REQUIRED','Use a UUID-v4 Idempotency-Key');
      const input=kind==='revisions'?saveStorySchema.parse(body):kind==='waivers'?waiverSchema.parse(body):expectedSchema.parse(body);
      return c.json(await command(filmId,operator,key.data,kind==='revisions'?'save':kind==='waivers'?'waiver':kind,input),kind==='revisions'?201:200);
    });
    api.all(route,c=>{c.header('Allow','POST');throw new ApiFailure(405,'METHOD_NOT_ALLOWED','Use POST');});
  }
  for(const route of ['/api/films/:filmId/storyboard','/api/films/:filmId/storyboard/revisions/:revisionId'])api.all(route,c=>{c.header('Allow','GET');throw new ApiFailure(405,'METHOD_NOT_ALLOWED','Use GET');});
  return api;
}
